// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import {
  CONFIG_VERSION,
  type ConfigIssue,
  defineConfig,
  formatIssues,
  isRepositoryUrl,
  migrateConfig,
  parseConfig,
  trimTrailingSlashes,
} from '../src/config/schema.js';

const minimal = {
  repo: { url: 'https://github.com/acme/app.git' },
  workspace: { path: '/srv/app' },
  service: { type: 'none' },
};

const issuesOf = (input: unknown): ConfigIssue[] => {
  const result = parseConfig(input);
  if (result.ok) {
    throw new Error('expected issues');
  }
  return result.issues;
};

const paths = (input: unknown) => issuesOf(input).map(({ path }) => path);

describe('parseConfig', () => {
  it('fills in every default', () => {
    const result = parseConfig(minimal);
    expect(result.ok && result.config).toEqual({
      version: CONFIG_VERSION,
      repo: { url: 'https://github.com/acme/app.git', branch: 'main', remote: 'origin', provider: 'auto' },
      track: { mode: 'branch', tagPattern: 'v*', prerelease: false, requireSignature: false },
      workspace: {
        path: '/srv/app',
        shallow: false,
        strategy: 'in-place',
        install: {
          enabled: false,
          command: 'npm ci',
          when: 'changed',
          watch: expect.arrayContaining(['package.json']),
        },
      },
      service: { type: 'none', sudo: false },
      hooks: { timeoutSeconds: 600 },
      rollback: { enabled: true },
      schedule: { enabled: true, intervalSeconds: 60, jitterSeconds: 0 },
      webhook: { enabled: false, host: '127.0.0.1', port: 9000, path: '/hooks/self-updater' },
      notifications: [],
      logging: { level: 'info', format: 'text' },
    });
    expect(result.ok && result.migrated).toBe(false);
  });

  it('keeps every optional setting', () => {
    const result = parseConfig({
      version: 3,
      repo: {
        url: 'git@gitlab.example.com:group/app.git',
        token: 't',
        apiUrl: 'https://gitlab.example.com/api/v4//',
        provider: 'gitlab',
      },
      track: {
        mode: 'tag',
        tagPattern: 'release-*',
        prerelease: true,
        requireSignature: true,
        allowedSigners: 'signers',
      },
      workspace: {
        path: 'app',
        shallow: true,
        install: { enabled: true, command: 'pnpm i', when: 'always', watch: ['pnpm-lock.yaml'] },
      },
      service: { type: 'compose', composeFile: 'compose.yml', composeService: 'web', sudo: true },
      hooks: { preUpdate: 'pre', postUpdate: 'post', timeoutSeconds: 30 },
      healthCheck: { url: 'http://localhost/health', command: 'true', expectStatus: 204, retries: 0 },
      rollback: { enabled: false },
      schedule: { enabled: false, intervalSeconds: 15, jitterSeconds: 5 },
      webhook: { enabled: true, host: '0.0.0.0', port: 8080, path: '/deploy', secret: 's'.repeat(32) },
      notifications: [{ type: 'slack', url: 'https://hooks.slack.com/x', events: ['failure'] }],
      logging: { level: 'debug', format: 'json', file: 'log/updater.log' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.repo.apiUrl).toBe('https://gitlab.example.com/api/v4');
      expect(result.config.healthCheck).toEqual({
        url: 'http://localhost/health',
        command: 'true',
        expectStatus: 204,
        timeoutSeconds: 10,
        retries: 0,
        intervalSeconds: 5,
        startDelaySeconds: 0,
      });
      expect(result.config.notifications).toEqual([
        { type: 'slack', url: 'https://hooks.slack.com/x', events: ['failure'] },
      ]);
      expect(result.config.track.allowedSigners).toBe('signers');
      expect(result.config.logging.file).toBe('log/updater.log');
    }
  });

  it('reports every problem at once', () => {
    expect(paths({})).toEqual(['repo', 'workspace', 'service']);
    expect(paths(null)).toEqual(['']);
    expect(paths({ ...minimal, version: 9 })).toEqual(['version']);
  });

  it('checks types, ranges and formats', () => {
    const issues = paths({
      repo: { url: '-u', branch: 'a..b', remote: 'bad remote', provider: 'svn', apiUrl: 'ftp://x', token: 5 },
      track: { mode: 'commit', prerelease: 'yes' },
      workspace: { path: '/srv', install: { watch: [''] } },
      service: { type: 'pm2', name: 'a;rm' },
      hooks: { timeoutSeconds: 0 },
      schedule: { intervalSeconds: 5 },
      logging: { level: 'trace' },
      webhook: 'on',
      notifications: [{ type: 'teams', url: 'mailto:x', events: ['deployed'] }, {}],
    });
    expect(issues).toEqual(
      expect.arrayContaining([
        'repo.url',
        'repo.branch',
        'repo.remote',
        'repo.provider',
        'repo.apiUrl',
        'repo.token',
        'track.mode',
        'track.prerelease',
        'workspace.install.watch',
        'service.name',
        'hooks.timeoutSeconds',
        'schedule.intervalSeconds',
        'logging.level',
        'webhook',
        'notifications.0.type',
        'notifications.0.url',
        'notifications.0.events',
        'notifications.1.url',
      ])
    );
    expect(paths({ ...minimal, notifications: 'x' })).toEqual(['notifications']);
    expect(paths({ ...minimal, repo: { url: 'x'.repeat(5000) } })).toEqual(['repo.url']);
  });

  it('requires what each service type needs', () => {
    for (const type of ['pm2', 'docker', 'systemd']) {
      expect(paths({ ...minimal, service: { type } })).toEqual(['service.name']);
    }
    expect(paths({ ...minimal, service: { type: 'compose' } })).toEqual(['service.composeService']);
    expect(paths({ ...minimal, service: { type: 'command' } })).toEqual(['service.command']);
    expect(parseConfig({ ...minimal, service: { type: 'docker', command: 'docker restart web' } }).ok).toBe(true);
    expect(parseConfig({ ...minimal, service: { type: 'compose', name: 'web' } }).ok).toBe(true);
  });

  it('needs a secret for the webhook and a trigger', () => {
    expect(paths({ ...minimal, webhook: { enabled: true } })).toEqual(['webhook.secret']);
    expect(paths({ ...minimal, webhook: { enabled: true, secret: 'short' } })).toEqual(['webhook.secret']);
    expect(paths({ ...minimal, schedule: { enabled: false } })).toEqual(['schedule.enabled']);
    expect(paths({ ...minimal, webhook: { path: 'no-slash' } })).toEqual(['webhook.path']);
  });

  it('needs a target for the health check', () => {
    expect(paths({ ...minimal, healthCheck: {} })).toEqual(['healthCheck']);
    expect(paths({ ...minimal, healthCheck: { url: 'localhost:3000' } })).toEqual(['healthCheck.url']);
    expect(paths({ ...minimal, healthCheck: { url: 'https://user:pw@example.com/health' } })).toEqual([
      'healthCheck.url',
    ]);
  });
});

describe('migrateConfig', () => {
  it('converts the 2.x format', () => {
    const v2 = {
      version: 2,
      repo: { url: 'https://github.com/acme/app.git', branch: 'prod', remote: 'up', authToken: '${GITHUB_TOKEN}' },
      workspace: { localPath: '/srv/app', autoInstall: true, shallowClone: true },
      service: { type: 'docker', name: 'app', dockerCompose: true, dockerComposeFile: 'compose.yml' },
      schedule: { intervalSeconds: 120, jitterSeconds: 30 },
      hooks: { preUpdate: 'npm run migrate', postUpdate: 'curl -f localhost' },
      logging: { level: 'debug', file: '/var/log/su.log' },
    };
    const result = parseConfig(v2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migrated).toBe(true);
    expect(result.config.repo).toEqual({
      url: 'https://github.com/acme/app.git',
      branch: 'prod',
      remote: 'up',
      token: '${GITHUB_TOKEN}',
      provider: 'auto',
    });
    expect(result.config.workspace).toMatchObject({
      path: '/srv/app',
      shallow: true,
      install: { enabled: true, command: 'npm install' },
    });
    expect(result.config.service).toEqual({
      type: 'compose',
      name: 'app',
      composeFile: 'compose.yml',
      composeService: 'app',
      sudo: false,
    });
    expect(result.config.rollback.enabled).toBe(false);
    expect(result.config.hooks).toMatchObject({ preUpdate: 'npm run migrate', postUpdate: 'curl -f localhost' });
    expect(result.config.logging).toEqual({ level: 'debug', format: 'text', file: '/var/log/su.log' });
  });

  it('converts the 1.x format', () => {
    const result = parseConfig({
      repoUrl: 'https://github.com/acme/app.git',
      localPath: '/srv/app',
      serviceType: 'pm2',
      serviceName: 'app',
      checkInterval: 30,
      restartCommand: 'pm2 restart app',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.service).toEqual({ type: 'pm2', name: 'app', command: 'pm2 restart app', sudo: false });
    expect(result.config.schedule.intervalSeconds).toBe(30);
  });

  it('leaves current and unknown input alone', () => {
    expect(migrateConfig(minimal)).toEqual({ raw: minimal, migrated: false });
    expect(migrateConfig('text')).toEqual({ raw: 'text', migrated: false });
    expect(parseConfig({ version: 2 }).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('recognises repository URLs', () => {
    for (const url of [
      'https://x/y.git',
      'ssh://git@x/y',
      'git@github.com:a/b.git',
      '/srv/repo',
      'C:\\repo',
      'file:///srv/repo',
    ]) {
      expect(isRepositoryUrl(url), url).toBe(true);
    }
    for (const url of ['', '-oProxyCommand=x', 'a b', 'ftp://x/y', 'https://[bad']) {
      expect(isRepositoryUrl(url), url).toBe(false);
    }
  });

  it('formats issues and trims slashes', () => {
    expect(
      formatIssues([
        { path: 'a.b', message: 'is wrong' },
        { path: '', message: 'is empty' },
      ])
    ).toBe('- a.b is wrong\n- configuration is empty');
    expect(trimTrailingSlashes('https://x///')).toBe('https://x');
    expect(trimTrailingSlashes('///')).toBe('');
    expect(defineConfig(minimal as Parameters<typeof defineConfig>[0])).toBe(minimal);
  });
});
