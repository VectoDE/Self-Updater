import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UpdaterConfigInput } from '../src/config/schema.js';
import { isSelfUpdaterError } from '../src/errors.js';
import { repositoryLabel, Updater } from '../src/updater.js';
import { git, makeConfig, nodeScript, recordingLogger, Remote, startServer, tempDir } from './helpers.js';

/**
 * Every command of the deployment runs one script that writes "<step> <version>" to a log, so a test can read
 * which step ran on which version. A file named "broken" in the commit fails the health check; a file
 * fail-<step> next to the script fails that step.
 */
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
  const workspace = path.join(tempDir(), 'app');
  const config = makeConfig({
    repo: { url: remote.url },
    workspace: { path: workspace, install: { enabled: true, command: `${actor} install` } },
    service: { type: 'command', command: `${actor} restart` },
    hooks: { preUpdate: `${actor} pre`, postUpdate: `${actor} post` },
    healthCheck: { command: `${actor} health`, retries: 0 },
    ...overrides,
  });
  const { logger, records } = recordingLogger();
  const statePath = path.join(tempDir(), 'updater.state.json');
  const updater = new Updater(config, { statePath, logger, wait: () => Promise.resolve() });
  const log = (): string[] => {
    const file = path.join(scripts, 'log.txt');
    const lines = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : [];
    writeFileSync(file, '');
    return lines.filter(Boolean);
  };
  const failStep = (step: string) => {
    writeFileSync(path.join(scripts, `fail-${step}`), '');
  };
  return { remote, updater, workspace, scripts, log, failStep, records };
};

describe('Updater.update', () => {
  it('deploys the first version and then reports up to date', async () => {
    const { remote, updater, workspace, log } = setup();
    const v1 = remote.head();
    const result = await updater.update();
    expect(result).toMatchObject({
      outcome: 'deployed',
      commit: v1,
      target: { kind: 'branch', ref: 'main', commit: v1 },
    });
    expect(result.previousCommit).toBeUndefined();
    expect(readFileSync(path.join(workspace, 'version'), 'utf8')).toBe('1');
    expect(log()).toEqual(['pre -', 'install 1', 'restart 1', 'health 1', 'post 1']);
    expect(updater.readState()).toMatchObject({ lastCommit: v1, lastRef: 'main' });

    expect(await updater.update()).toMatchObject({ outcome: 'up-to-date', commit: v1, previousCommit: v1 });
    expect(log()).toEqual([]);
  });

  it('installs only when a watched file changed', async () => {
    const { remote, updater, log } = setup();
    await updater.update();
    log();
    remote.commit({ version: '2' });
    await updater.update();
    expect(log()).toEqual(['pre 1', 'restart 2', 'health 2', 'post 2']);
    remote.commit({ version: '3', 'package.json': '{"v":3}' });
    await updater.update();
    expect(log()).toContain('install 3');
  });

  it('cancels the update when the pre-update hook fails, without touching the checkout', async () => {
    const { remote, updater, workspace, log, failStep } = setup();
    const v1 = remote.head();
    await updater.update();
    log();
    const v2 = remote.commit({ version: '2' });
    failStep('pre');
    const result = await updater.update();
    expect(result).toMatchObject({ outcome: 'failed', commit: v1, previousCommit: v1 });
    expect(result.error).toMatch(/^pre-update hook: .*exited with 3/);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(v1);
    expect(log()).toEqual(['pre 1']);
    expect(updater.readState().failedCommit).toBe(v2);
  });

  it('rolls back when the health check fails and skips that commit afterwards', async () => {
    const { remote, updater, workspace, log, records } = setup();
    const v1 = remote.head();
    await updater.update();
    log();
    const v2 = remote.commit({ version: '2', broken: '' });
    const result = await updater.update();
    expect(result).toMatchObject({ outcome: 'rolled-back', commit: v1, previousCommit: v1, target: { commit: v2 } });
    expect(result.error).toMatch(/health command exited with 1/);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(v1);
    // The new version gets no post-update hook; the old one comes back with restart and health check (no install,
    // because the dependencies did not change).
    expect(log()).toEqual(['pre 1', 'restart 2', 'health 2', 'restart 1', 'health 1']);
    expect(records.some(({ message }) => message === 'Rolling back')).toBe(true);

    expect(await updater.update()).toMatchObject({ outcome: 'skipped', commit: v1 });
    expect(log()).toEqual([]);
    expect(await updater.update({ dryRun: true, force: true })).toMatchObject({ outcome: 'dry-run', commit: v1 });
  });

  it('deploys a failed commit again with force', async () => {
    const { remote, updater, scripts, failStep } = setup();
    await updater.update();
    remote.commit({ version: '2' });
    failStep('post');
    expect((await updater.update()).outcome).toBe('rolled-back');
    unlinkSync(path.join(scripts, 'fail-post'));
    expect((await updater.update()).outcome).toBe('skipped');
    expect((await updater.update({ force: true })).outcome).toBe('deployed');
    expect(updater.readState().failedCommit).toBeUndefined();
  });
});

describe('Updater failures without rollback', () => {
  it('reports a failed restart when rollback is off', async () => {
    const { remote, updater, workspace, failStep } = setup({ rollback: { enabled: false } });
    await updater.update();
    const v2 = remote.commit({ version: '2' });
    failStep('restart');
    const result = await updater.update();
    expect(result).toMatchObject({ outcome: 'failed', commit: v2 });
    expect(result.error).toMatch(/restart broke/);
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(v2);
  });

  it('cannot roll back the very first deployment', async () => {
    const { updater, failStep } = setup();
    failStep('install');
    expect((await updater.update()).outcome).toBe('failed');
  });

  it('reports a rollback that fails too', async () => {
    const { remote, updater, failStep } = setup();
    await updater.update();
    remote.commit({ version: '2' });
    failStep('restart');
    const result = await updater.update();
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/rollback failed too/);
  });
});

describe('Updater with tags and signatures', () => {
  it('deploys the newest release tag', async () => {
    const { remote, updater, workspace } = setup({ track: { mode: 'tag' } });
    remote.annotatedTag('v1.0.0');
    const v2 = remote.commit({ version: '2' });
    remote.tag('v1.1.0');
    remote.commit({ version: 'unreleased' });
    expect(await updater.update()).toMatchObject({
      outcome: 'deployed',
      commit: v2,
      target: { kind: 'tag', ref: 'v1.1.0' },
    });
    expect(readFileSync(path.join(workspace, 'version'), 'utf8')).toBe('2');
  });

  it('refuses an unsigned commit when signatures are required', async () => {
    const { updater, log } = setup({ track: { requireSignature: true } });
    const result = await updater.update();
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/^signature check: Commit \w+ has no valid signature/);
    expect(log()).toEqual([]);
    expect(await updater.git.head()).toBeUndefined();
  });
});

describe('Updater.status and rollbackTo', () => {
  it('reports the state without changing anything', async () => {
    const { remote, updater } = setup();
    const before = await updater.status();
    expect(before).toMatchObject({ updateAvailable: true, skipped: false, target: { commit: remote.head() } });
    expect(before.current).toBeUndefined();
    await updater.update();
    expect(await updater.status()).toMatchObject({ updateAvailable: false, current: remote.head() });
  });

  it('goes back to the commit before the last deployment and marks the newer one as failed', async () => {
    const { remote, updater, workspace, log } = setup();
    const v1 = remote.head();
    await updater.update();
    const v2 = remote.commit({ version: '2' });
    await updater.update();
    log();
    expect(await updater.rollbackTo()).toMatchObject({ outcome: 'rolled-back', commit: v1, previousCommit: v2 });
    expect(git(workspace, 'rev-parse', 'HEAD')).toBe(v1);
    expect(log()).toEqual(['restart 1', 'health 1']);
    expect(updater.readState().failedCommit).toBe(v2);
    expect((await updater.update()).outcome).toBe('skipped');
  });

  it('needs an earlier commit that exists', async () => {
    const { updater } = setup();
    await expect(updater.rollbackTo()).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'NO_PREVIOUS_COMMIT'));
    await updater.update();
    await expect(updater.rollbackTo()).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'NO_PREVIOUS_COMMIT'));
    await expect(updater.rollbackTo('f'.repeat(40))).rejects.toSatisfy((error) =>
      isSelfUpdaterError(error, 'TARGET_NOT_FOUND')
    );
  });
});

describe('notifications and labels', () => {
  it('notifies about deployments and rollbacks without secrets', async () => {
    const server = await startServer((_, response) => response.writeHead(204).end());
    const { remote, updater } = setup({
      notifications: [{ type: 'webhook', url: `${server.url}/hook`, events: ['success', 'rollback'] }],
    });
    await updater.update();
    remote.commit({ version: '2', broken: '' });
    await updater.update();
    const events = server.requests.map(({ body }) => JSON.parse(body) as { event: string; failedCommit?: string });
    expect(events.map(({ event }) => event)).toEqual(['success', 'rollback']);
    expect(events[1]?.failedCommit).toBe(remote.head());
  });

  it('labels repositories without credentials', () => {
    expect(repositoryLabel('https://user:pass@github.com/acme/app.git')).toBe('acme/app');
    expect(repositoryLabel('https://user:pass@example.com/')).toBe('https://example.com/');
    expect(repositoryLabel('/srv/repo')).toBe('/srv/repo');
  });
});
