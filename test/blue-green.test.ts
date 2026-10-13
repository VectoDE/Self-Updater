// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { describe, expect, it } from 'vitest';
import type { UpdaterConfigInput } from '../src/config/schema.js';
import { isSelfUpdaterError } from '../src/errors.js';
import { Slots } from '../src/slots.js';
import { Updater } from '../src/updater.js';
import { makeConfig, nodeScript, recordingLogger, Remote, tempDir } from './helpers.js';

/** Writes "<step> <version>" to a log next to the script; "broken" fails the health check, fail-<step> that step. */
const ACTOR = `
const fs = require('fs');
const path = require('path');
const step = process.argv[2];
const version = fs.existsSync('version') ? fs.readFileSync('version', 'utf8').trim() : '-';
fs.appendFileSync(path.join(__dirname, 'log.txt'), step + ' ' + version + '\\n');
if (step === 'health' && fs.existsSync('broken')) process.exit(1);
if (fs.existsSync(path.join(__dirname, 'fail-' + step))) { console.error(step + ' broke'); process.exit(3); }
`;

const setup = (overrides: Partial<UpdaterConfigInput> = {}) => {
  const remote = new Remote();
  remote.commit({ version: '1', 'package.json': '{"v":1}' }, 'v1');
  const scripts = tempDir('su-scripts-');
  const actor = nodeScript(scripts, 'actor.js', ACTOR);
  const link = path.join(tempDir(), 'app');
  const config = makeConfig({
    repo: { url: remote.url },
    workspace: {
      path: link,
      strategy: 'blue-green',
      install: { enabled: true, command: `${actor} install` },
    },
    service: { type: 'command', command: `${actor} restart` },
    hooks: { preUpdate: `${actor} pre`, postUpdate: `${actor} post` },
    healthCheck: { command: `${actor} health`, retries: 0 },
    ...overrides,
  });
  const { logger } = recordingLogger();
  const updater = new Updater(config, {
    statePath: path.join(tempDir(), 'updater.state.json'),
    logger,
    wait: () => Promise.resolve(),
  });
  const log = (): string[] => {
    const file = path.join(scripts, 'log.txt');
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').trim().split('\n');
    } catch {
      // Nothing has run yet.
    }
    writeFileSync(file, '');
    return lines.filter(Boolean);
  };
  const failStep = (step: string) => {
    writeFileSync(path.join(scripts, `fail-${step}`), '');
  };
  const slots = new Slots(link);
  const live = () => realpathSync(link);
  const version = (slot: 'blue' | 'green') => readFileSync(path.join(slots.dir(slot), 'version'), 'utf8');
  return { remote, updater, link, slots, live, version, log, failStep };
};

describe('blue-green workspaces', () => {
  it('deploys into the idle slot and moves the link', async () => {
    const { remote, updater, link, slots, live, version, log } = setup();
    const v1 = remote.head();
    expect(await updater.update()).toMatchObject({ outcome: 'deployed', commit: v1 });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(live()).toBe(realpathSync(slots.dir('blue')));
    expect(updater.activeSlot()).toBe('blue');
    expect(log()).toEqual(['pre -', 'install 1', 'restart 1', 'health 1', 'post 1']);

    const v2 = remote.commit({ version: '2' }, 'v2');
    expect(await updater.update()).toMatchObject({ outcome: 'deployed', commit: v2, previousCommit: v1 });
    expect(updater.activeSlot()).toBe('green');
    // The hook before the update runs in the live checkout; the old slot keeps its version for a rollback.
    expect(log()).toEqual(['pre 1', 'install 2', 'restart 2', 'health 2', 'post 2']);
    expect(version('blue')).toBe('1');
    expect((await updater.status()).current).toBe(v2);
  });

  it('installs in the idle slot only when its own dependencies changed', async () => {
    const { remote, updater, log } = setup();
    await updater.update();
    remote.commit({ version: '2' }, 'v2');
    await updater.update();
    log();
    // Back in blue: blue had v1 with the same package.json, so v3 needs no install there.
    remote.commit({ version: '3' }, 'v3');
    await updater.update();
    expect(log()).toEqual(['pre 2', 'restart 3', 'health 3', 'post 3']);
    expect(updater.activeSlot()).toBe('blue');
  });

  it('leaves the live version alone when the install fails', async () => {
    const { remote, updater, failStep, log } = setup();
    const v1 = remote.head();
    await updater.update();
    log();
    const v2 = remote.commit({ version: '2', 'package.json': '{"v":2}' }, 'v2');
    failStep('install');
    const result = await updater.update();
    expect(result).toMatchObject({ outcome: 'failed', commit: v1, previousCommit: v1 });
    expect(result.error).toMatch(/^install: install command exited with 3/);
    expect(updater.activeSlot()).toBe('blue');
    // No restart: nothing that runs has changed.
    expect(log()).toEqual(['pre 1', 'install 2']);
    expect(updater.readState().failedCommit).toBe(v2);
    expect(await updater.update()).toMatchObject({ outcome: 'skipped' });
  });

  it('moves the link back when the new version fails its health check', async () => {
    const { remote, updater, version, log } = setup();
    const v1 = remote.head();
    await updater.update();
    log();
    remote.commit({ version: '2', broken: '' }, 'v2');
    const result = await updater.update();
    expect(result).toMatchObject({ outcome: 'rolled-back', commit: v1 });
    expect(updater.activeSlot()).toBe('blue');
    // The way back is a restart of the old slot, without install.
    expect(log()).toEqual(['pre 1', 'install 2', 'restart 2', 'health 2', 'restart 1', 'health 1']);
    expect(version('green')).toBe('2');
  });

  it('keeps the new version when rollback is off', async () => {
    const { remote, updater } = setup({ rollback: { enabled: false } });
    await updater.update();
    const v2 = remote.commit({ version: '2', broken: '' }, 'v2');
    expect(await updater.update()).toMatchObject({ outcome: 'failed', commit: v2 });
    expect(updater.activeSlot()).toBe('green');
  });

  it('rolls back by hand to the other slot', async () => {
    const { remote, updater, log } = setup();
    const v1 = remote.head();
    await updater.update();
    remote.commit({ version: '2' }, 'v2');
    await updater.update();
    log();
    expect(await updater.rollbackTo()).toMatchObject({ outcome: 'rolled-back', commit: v1 });
    expect(updater.activeSlot()).toBe('blue');
    expect(log()).toEqual(['restart 1', 'health 1']);
  });

  it('refuses a rollback with nothing to go back to', async () => {
    const { updater } = setup();
    await expect(updater.rollbackTo()).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'NO_PREVIOUS_COMMIT'));
    await updater.update();
    await expect(updater.rollbackTo('0'.repeat(40))).rejects.toSatisfy((error) =>
      isSelfUpdaterError(error, 'TARGET_NOT_FOUND')
    );
  });

  it('takes over an empty directory but never a checkout', async () => {
    const empty = setup();
    mkdirSync(empty.link, { recursive: true });
    expect(await empty.updater.update()).toMatchObject({ outcome: 'deployed' });
    expect(empty.updater.activeSlot()).toBe('blue');

    const used = setup();
    mkdirSync(used.link, { recursive: true });
    writeFileSync(path.join(used.link, 'server.js'), '');
    await expect(used.updater.update()).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'WORKSPACE_NOT_LINK'));
  });

  it('reports a link that points somewhere else', async () => {
    const elsewhere = tempDir();
    const link = path.join(tempDir(), 'app');
    await symlink(elsewhere, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => new Slots(link).active()).toThrow(/neither slot/);
  });
});
