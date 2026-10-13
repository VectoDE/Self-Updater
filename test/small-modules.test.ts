// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, parseConfigSet, type ServiceConfig } from '../src/config/schema.js';
import { isSelfUpdaterError, messageOf, SelfUpdaterError } from '../src/errors.js';
import { acquireLock } from '../src/lock.js';
import { createEvent, notify, payloadFor, summarize } from '../src/notify.js';
import { restartCommand } from '../src/service.js';
import { readState, recordDeployment, writeState } from '../src/state.js';
import { recordingLogger, startServer, tempDir } from './helpers.js';

describe('errors', () => {
  it('carries a code and a cause', () => {
    const cause = new Error('inner');
    const error = new SelfUpdaterError('LOCKED', 'busy', { cause });
    expect(error.name).toBe('SelfUpdaterError');
    expect(error.cause).toBe(cause);
    expect(isSelfUpdaterError(error)).toBe(true);
    expect(isSelfUpdaterError(error, 'LOCKED')).toBe(true);
    expect(isSelfUpdaterError(error, 'GIT_FAILED')).toBe(false);
    expect(isSelfUpdaterError(cause)).toBe(false);
    expect(messageOf(error)).toBe('busy');
    expect(messageOf('plain')).toBe('plain');
  });
});

describe('restartCommand', () => {
  const service = (fields: Partial<ServiceConfig>): ServiceConfig => ({ type: 'none', sudo: false, ...fields });

  it('builds argument lists for the built-in types', () => {
    expect(restartCommand(service({ type: 'pm2', name: 'api' }), 'linux')).toEqual([
      'pm2',
      'reload',
      'api',
      '--update-env',
    ]);
    expect(restartCommand(service({ type: 'docker', name: 'web' }), 'linux')).toEqual(['docker', 'restart', 'web']);
    expect(restartCommand(service({ type: 'systemd', name: 'app.service', sudo: true }), 'linux')).toEqual([
      'sudo',
      '-n',
      'systemctl',
      'restart',
      'app.service',
    ]);
    expect(
      restartCommand(service({ type: 'compose', composeFile: 'prod.yml', composeService: 'web' }), 'linux')
    ).toEqual(['docker', 'compose', '-f', 'prod.yml', 'up', '--detach', '--build', '--remove-orphans', 'web']);
    expect(restartCommand(service({ type: 'compose', name: 'web' }), 'linux')).toContain('web');
  });

  it('uses the custom command, a shell line on Windows, or nothing', () => {
    expect(restartCommand(service({ type: 'pm2', name: 'api', command: 'pm2 restart api' }))).toBe('pm2 restart api');
    expect(restartCommand(service({ type: 'pm2', name: 'api' }), 'win32')).toBe('pm2 reload api --update-env');
    expect(restartCommand(service({ type: 'none' }))).toBeUndefined();
    expect(restartCommand(service({ type: 'pm2' }), 'linux')).toEqual(['pm2', 'reload', '', '--update-env']);
    expect(restartCommand(service({ type: 'docker' }), 'linux')).toEqual(['docker', 'restart', '']);
    expect(restartCommand(service({ type: 'systemd' }), 'linux')).toEqual(['systemctl', 'restart', '']);
    expect(restartCommand(service({ type: 'compose' }), 'linux')).toContain('');
  });
});

describe('state', () => {
  it('records deployments and failures', async () => {
    const file = path.join(tempDir(), 'updater.state.json');
    expect(readState(file)).toEqual({ history: [] });
    let state = recordDeployment(readState(file), { outcome: 'deployed', ref: 'main', commit: 'a', time: 't1' });
    state = recordDeployment(state, {
      outcome: 'rolled-back',
      ref: 'main',
      commit: 'b',
      previousCommit: 'a',
      time: 't2',
    });
    await writeState(file, state);
    const loaded = readState(file);
    expect(loaded).toMatchObject({ lastCommit: 'a', lastRef: 'main', updatedAt: 't1', failedCommit: 'b' });
    expect(loaded.history.map(({ commit }) => commit)).toEqual(['b', 'a']);
    const fixed = recordDeployment(loaded, { outcome: 'deployed', ref: 'main', commit: 'c', time: 't3' });
    expect(fixed.failedCommit).toBeUndefined();
  });

  it('keeps fifty entries and survives a broken file', () => {
    let state = readState('/does/not/exist.json');
    for (let index = 0; index < 60; index++) {
      state = recordDeployment(state, { outcome: 'deployed', ref: 'main', commit: String(index), time: 't' });
    }
    expect(state.history).toHaveLength(50);
    const file = path.join(tempDir(), 'broken.json');
    writeFileSync(file, '{"history": "nope"}');
    expect(readState(file).history).toEqual([]);
  });
});

describe('acquireLock', () => {
  it('lets only one holder in and releases', async () => {
    const file = path.join(tempDir(), 'lock');
    const release = await acquireLock(file);
    await expect(acquireLock(file)).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'LOCKED'));
    await release();
    expect(existsSync(file)).toBe(false);
    const again = await acquireLock(file);
    await again();
  });

  it('takes over a lock of a process that is gone, an old one, or a broken file', async () => {
    const file = path.join(tempDir(), 'lock');
    writeFileSync(file, JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), since: new Date().toISOString() }));
    await (
      await acquireLock(file)
    )();
    writeFileSync(file, JSON.stringify({ pid: process.pid, host: 'other-host', since: '2000-01-01T00:00:00Z' }));
    await (
      await acquireLock(file)
    )();
    writeFileSync(file, 'garbage');
    const release = await acquireLock(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
    await release();
  });

  it('keeps a lock held by a running process on another host', async () => {
    const file = path.join(tempDir(), 'lock');
    writeFileSync(file, JSON.stringify({ pid: 1, host: 'other-host', since: new Date().toISOString() }));
    await expect(acquireLock(file)).rejects.toThrow(/pid 1 on other-host/);
  });

  it('does not remove a lock someone else took over', async () => {
    const file = path.join(tempDir(), 'lock');
    const release = await acquireLock(file);
    writeFileSync(file, JSON.stringify({ pid: 1, host: 'other', since: new Date().toISOString() }));
    await release();
    expect(existsSync(file)).toBe(true);
  });

  it('passes on unexpected file system errors', async () => {
    await expect(acquireLock(path.join(tempDir(), 'missing', 'lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('notifications', () => {
  const event = createEvent({
    event: 'rollback',
    repository: 'acme/app',
    ref: 'main',
    commit: 'a'.repeat(40),
    failedCommit: 'b'.repeat(40),
    error: 'health check failed',
    host: 'web-1',
    time: 'now',
  });

  it('summarizes every event', () => {
    expect(summarize(event)).toBe(
      'Deployment of bbbbbbbbbbbb failed on acme/app (main) on web-1; rolled back to aaaaaaaaaaaa. health check failed'
    );
    expect(summarize({ ...event, event: 'success' })).toBe('Deployed aaaaaaaaaaaa of acme/app (main) on web-1.');
    expect(summarize({ ...event, event: 'failure', failedCommit: undefined, error: undefined } as never)).toBe(
      'Deployment of unknown failed on acme/app (main) on web-1.'
    );
    expect(createEvent({ event: 'success', repository: 'r', ref: 'main' }).host).toBe(os.hostname());
  });

  it('shapes payloads per service', () => {
    expect(payloadFor('slack', event)).toEqual({ text: summarize(event) });
    expect(payloadFor('discord', { ...event, error: 'x'.repeat(3000) })).toMatchObject({
      allowed_mentions: { parse: [] },
    });
    expect((payloadFor('discord', { ...event, error: 'x'.repeat(3000) }) as { content: string }).content).toHaveLength(
      2000
    );
    expect(payloadFor('webhook', event)).toMatchObject({
      event: 'rollback',
      repository: 'acme/app',
      text: summarize(event),
    });
  });

  it('sends to subscribed targets and logs failures without throwing', async () => {
    const ok = await startServer((_, response) => response.writeHead(204).end());
    const failing = await startServer((_, response) => response.writeHead(500).end());
    const { logger, records } = recordingLogger();
    const sent = await notify(
      [
        { type: 'slack', url: `${ok.url}/slack`, events: ['rollback'] },
        { type: 'webhook', url: `${ok.url}/skip`, events: ['success'] },
        { type: 'discord', url: `${failing.url}/discord`, events: ['rollback', 'failure'] },
        { type: 'webhook', url: 'http://127.0.0.1:1/unreachable', events: ['rollback'] },
      ],
      event,
      { logger }
    );
    expect(sent).toBe(1);
    expect(ok.requests.map(({ url }) => url)).toEqual(['/slack']);
    expect(JSON.parse(ok.requests[0]!.body)).toEqual({ text: summarize(event) });
    expect(records.filter(({ message }) => message === 'Notification failed')).toHaveLength(2);
    expect(await notify([], event)).toBe(0);
  });
});

describe('configuration of examples', () => {
  it('accepts every example file in the repository', () => {
    for (const name of ['pm2', 'compose', 'systemd-tags']) {
      const file = path.join(import.meta.dirname, '..', 'examples', `${name}.json`);
      const source = readFileSync(file, 'utf8')
        .replaceAll(/\$\{[A-Z_]+_URL\}/g, 'https://example.com/hook')
        .replaceAll(/\$\{[A-Z_]+\}/g, 'x'.repeat(32));
      const result = parseConfig(JSON.parse(source));
      expect(result.ok ? [] : result.issues, name).toEqual([]);
    }
    const file = path.join(import.meta.dirname, '..', 'examples', 'workspaces.json');
    const source = readFileSync(file, 'utf8')
      .replaceAll(/\$\{[A-Z_]+_URL\}/g, 'https://example.com/hook')
      .replaceAll(/\$\{[A-Z_]+\}/g, 'x'.repeat(32));
    const set = parseConfigSet(JSON.parse(source));
    expect(set.ok ? [] : set.issues, 'workspaces').toEqual([]);
  });
});
