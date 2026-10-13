// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeWorkspace } from '../src/agent.js';
import { runCli } from '../src/cli/run.js';
import { loadConfigSet, statePathFor } from '../src/config/load.js';
import { parseConfig, parseConfigSet } from '../src/config/schema.js';
import { Fleet } from '../src/fleet.js';
import { Updater } from '../src/updater.js';
import { judgeSharedDelivery, startWebhookServer, workspacesFor } from '../src/webhook.js';
import { makeConfig, recordingLogger, Remote, slash, tempDir } from './helpers.js';

const SECRET = 'webhook-secret-0123456789abcdefghijk';
const TOKEN = 'status-token-0123456789abcdefghijklm';

const twoWorkspaces = (extra: Record<string, unknown> = {}) => ({
  version: 3,
  defaults: { service: { type: 'none' }, schedule: { intervalSeconds: 120 } },
  workspaces: [
    { name: 'shop', repo: { url: 'https://github.com/acme/shop.git' }, workspace: { path: '/srv/shop' } },
    {
      name: 'api',
      repo: { url: 'https://github.com/acme/api.git', branch: 'release' },
      workspace: { path: '/srv/api', strategy: 'blue-green' },
      schedule: { intervalSeconds: 30 },
    },
  ],
  ...extra,
});

describe('parseConfigSet', () => {
  it('merges each workspace over the defaults', () => {
    const result = parseConfigSet(twoWorkspaces());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [shop, api] = result.set.workspaces;
    expect(result.set.multiple).toBe(true);
    expect(shop).toMatchObject({
      name: 'shop',
      config: { schedule: { intervalSeconds: 120 }, repo: { branch: 'main' } },
    });
    expect(api).toMatchObject({
      name: 'api',
      config: { schedule: { intervalSeconds: 30 }, workspace: { strategy: 'blue-green' }, repo: { branch: 'release' } },
    });
  });

  it('treats a file without a list as one workspace named default', () => {
    const result = parseConfigSet({
      repo: { url: 'https://x/y.git' },
      workspace: { path: '/a' },
      service: { type: 'none' },
    });
    expect(result).toMatchObject({ ok: true, set: { multiple: false, workspaces: [{ name: 'default' }] } });
    expect(parseConfigSet({ repo: {} })).toMatchObject({ ok: false });
    expect(parseConfig(twoWorkspaces())).toMatchObject({ ok: false, issues: [{ path: 'workspaces' }] });
  });

  it('reports every problem with its place', () => {
    const result = parseConfigSet({
      version: 3,
      repo: { url: 'https://x/y.git' },
      defaults: { service: { type: 'none' }, logging: {} },
      webhook: { enabled: true, secret: 'short' },
      workspaces: [
        { name: 'a', repo: { url: 'https://x/a.git' }, workspace: { path: '/a' } },
        { name: 'a', repo: { url: 'https://x/b.git' }, workspace: { path: '/a' }, webhook: {} },
        { name: 'b c', workspace: { path: '/c' } },
        'nope',
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'repo',
        'defaults.logging',
        'webhook.secret',
        'workspaces.1.name',
        'workspaces.1.workspace.path',
        'workspaces.1.webhook',
        'workspaces.2.name',
        'workspaces.2.repo',
        'workspaces.3',
      ])
    );
    // The shared webhook problem is reported once, not per workspace.
    expect(paths.filter((item) => item === 'webhook.secret')).toHaveLength(1);
    expect(parseConfigSet({ version: 2, workspaces: [] })).toMatchObject({ ok: false, issues: [{ path: 'version' }] });
    expect(parseConfigSet({ workspaces: [] })).toMatchObject({ ok: false, issues: [{ path: 'workspaces' }] });
    expect(parseConfigSet({ defaults: 1, workspaces: {} })).toMatchObject({ ok: false });
  });

  it('checks the status endpoint settings', () => {
    const base = { repo: { url: 'https://x/y.git' }, workspace: { path: '/a' }, service: { type: 'none' } };
    const issues = (webhook: Record<string, unknown>) => {
      const result = parseConfig({ ...base, webhook: { enabled: true, secret: SECRET, ...webhook } });
      return result.ok ? [] : result.issues.map((issue) => `${issue.path} ${issue.message}`);
    };
    expect(issues({ statusPath: '/status' })).toEqual([]);
    expect(issues({ statusPath: '/status', host: '0.0.0.0' })).toEqual([
      'webhook.statusToken is required when the status endpoint listens on 0.0.0.0',
    ]);
    expect(issues({ statusPath: '/status', host: '0.0.0.0', statusToken: TOKEN })).toEqual([]);
    expect(issues({ statusPath: '/hooks/self-updater' })).toEqual(['webhook.statusPath must differ from webhook.path']);
    expect(issues({ statusPath: 'status', statusToken: 'short' })).toHaveLength(2);
  });
});

describe('loadConfigSet', () => {
  it('resolves paths per workspace and gives each its own state file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'updater.config.json');
    writeFileSync(file, JSON.stringify(twoWorkspaces({ logging: { file: 'logs/updater.log' } })));
    const { set } = loadConfigSet(file, {});
    expect(set.logging.file).toBe(path.join(dir, 'logs', 'updater.log'));
    expect(set.workspaces.map(({ config }) => config.logging.file)).toEqual([set.logging.file, set.logging.file]);
    expect(statePathFor(file)).toBe(path.join(dir, 'updater.state.json'));
    expect(statePathFor(file, 'shop')).toBe(path.join(dir, 'updater.state.shop.json'));
    writeFileSync(file, JSON.stringify({ workspaces: [] }));
    expect(() => loadConfigSet(file, {})).toThrow(/has problems/);
  });
});

const push = (ref: string, repository?: string) => {
  const body = JSON.stringify({ ref, ...(repository ? { repository: { full_name: repository } } : {}) });
  return {
    request: {
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
    },
    body: Buffer.from(body),
  };
};

describe('shared deliveries', () => {
  const shop = makeConfig({ repo: { url: 'https://github.com/acme/shop.git' }, workspace: { path: '/s' } });
  const api = makeConfig({ repo: { url: 'https://github.com/acme/api.git' }, workspace: { path: '/a' } });
  const webhook = { ...shop.webhook, enabled: true, secret: SECRET };

  it('reaches only the workspaces of the repository and ref', () => {
    const { request, body } = push('refs/heads/main', 'acme/API');
    const verdict = judgeSharedDelivery(webhook, [shop, api], request, body);
    expect(verdict).toMatchObject({ accepted: true, repository: 'acme/API' });
    if (!verdict.accepted) return;
    expect(workspacesFor([{ config: shop }, { config: api }], verdict).map(({ config }) => config)).toEqual([api]);

    const other = push('refs/heads/main', 'acme/blog');
    expect(judgeSharedDelivery(webhook, [shop, api], other.request, other.body)).toMatchObject({
      accepted: false,
      status: 202,
    });
    // Without a repository in the payload, the ref decides.
    const anonymous = push('refs/heads/main');
    expect(judgeSharedDelivery(webhook, [shop, api], anonymous.request, anonymous.body)).toMatchObject({
      accepted: true,
    });
    const wrongSecret = { ...anonymous.request, headers: { ...anonymous.request.headers, 'x-hub-signature-256': 'x' } };
    expect(judgeSharedDelivery(webhook, [shop], wrongSecret, anonymous.body)).toMatchObject({ status: 401 });
    expect(judgeSharedDelivery(webhook, [shop], anonymous.request, Buffer.from('{'))).toMatchObject({ status: 401 });
  });
});

const get = async (port: number, pathname: string, headers: Record<string, string> = {}, method = 'GET') => {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method, headers });
  return { status: response.status, text: await response.text() };
};

describe('status endpoint', () => {
  it('answers GET with the workspace state and checks the token', async () => {
    const config = makeConfig({
      repo: { url: 'https://github.com/acme/app.git' },
      workspace: { path: '/srv/app' },
      webhook: { enabled: true, secret: SECRET, statusPath: '/status', statusToken: TOKEN },
    });
    config.webhook.port = 0;
    const server = await startWebhookServer(config, () => undefined, { status: () => ({ hello: 'world' }) });
    try {
      expect(await get(server.port, '/status')).toMatchObject({ status: 401 });
      expect(await get(server.port, '/status', { Authorization: 'Bearer wrong' })).toMatchObject({ status: 401 });
      const ok = await get(server.port, '/status', { Authorization: `Bearer ${TOKEN}` });
      expect(ok.status).toBe(200);
      expect(JSON.parse(ok.text)).toEqual({ hello: 'world' });
      expect(await get(server.port, '/status', { Authorization: `Bearer ${TOKEN}` }, 'HEAD')).toEqual({
        status: 200,
        text: '',
      });
      expect(await get(server.port, '/status', {}, 'POST')).toMatchObject({ status: 405 });
      expect(await get(server.port, '/other')).toMatchObject({ status: 404 });
    } finally {
      await server.close();
    }
  });
});

describe('Fleet', () => {
  it('runs every workspace, routes deliveries and reports status', async () => {
    const shopRemote = new Remote();
    const apiRemote = new Remote();
    const base = tempDir();
    const webhook = { enabled: true, secret: SECRET, statusPath: '/status' };
    const member = (name: string, remote: Remote, strategy: 'in-place' | 'blue-green') => ({
      name,
      updater: new Updater(
        makeConfig({
          repo: { url: remote.url },
          workspace: { path: path.join(base, name), strategy },
          schedule: { enabled: false },
          webhook,
        }),
        { statePath: path.join(base, `${name}.json`) }
      ),
    });
    const members = [member('shop', shopRemote, 'in-place'), member('api', apiRemote, 'blue-green')];
    const { logger, records } = recordingLogger();
    const cycles: string[] = [];
    const shared = { ...members[0]!.updater.config.webhook, port: 0 };
    const fleet = new Fleet(members, shared, {
      logger,
      onCycle: (result) => cycles.push('outcome' in result ? result.outcome : result.message),
    });
    await fleet.start();
    try {
      const port = fleet.webhookPort ?? 0;
      // A delivery without a repository goes to both (both follow main).
      const { request, body } = push('refs/heads/main');
      const response = await fetch(`http://127.0.0.1:${port}/hooks/self-updater`, {
        method: 'POST',
        headers: request.headers,
        body,
      });
      expect(response.status).toBe(202);
      await expect.poll(() => cycles.length, { timeout: 20_000 }).toBe(2);
      expect(cycles).toEqual(['deployed', 'deployed']);
      const status = JSON.parse((await get(port, '/status')).text) as { workspaces: Record<string, unknown>[] };
      expect(status.workspaces).toEqual([
        expect.objectContaining({ name: 'shop', strategy: 'in-place', updating: false, deployed: expect.anything() }),
        expect.objectContaining({ name: 'api', strategy: 'blue-green', slot: 'blue' }),
      ]);
      expect(records.some((record) => record.fields.workspace === 'api')).toBe(true);
    } finally {
      await fleet.stop();
    }
    expect(fleet.webhookPort).toBeUndefined();
  });

  it('describes a workspace whose path the strategy cannot use without failing', () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'file'), '');
    const updater = new Updater(
      makeConfig({ repo: { url: 'https://x/y.git' }, workspace: { path: dir, strategy: 'blue-green' } }),
      { statePath: path.join(dir, 'state.json') }
    );
    const fleet = new Fleet([{ name: 'x', updater }], updater.config.webhook);
    expect(fleet.status().workspaces[0]).not.toHaveProperty('slot');
    expect(describeWorkspace('x', fleet.agents[0]!.agent)).toMatchObject({ name: 'x', updating: false });
  });
});

const cli = async (args: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, { stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: {} });
  return { code, out: out.join('\n'), last: out.at(-1) ?? '', err: err.join('\n') };
};

describe('CLI with several workspaces', () => {
  const project = () => {
    const shop = new Remote();
    const api = new Remote();
    const dir = tempDir();
    const file = path.join(dir, 'updater.config.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 3,
        defaults: { service: { type: 'none' } },
        workspaces: [
          { name: 'shop', repo: { url: slash(shop.url) }, workspace: { path: './shop' } },
          { name: 'api', repo: { url: slash(api.url) }, workspace: { path: './api', strategy: 'blue-green' } },
        ],
      })
    );
    return { shop, api, dir, file };
  };

  it('validates, updates all or one, and shows status per workspace', async () => {
    const { shop, dir, file } = project();
    expect(await cli(['validate', '-c', file])).toMatchObject({
      code: 0,
      last: expect.stringContaining('2 workspaces'),
    });
    const one = await cli(['update', '-c', file, '-w', 'shop']);
    expect(one).toMatchObject({ code: 0, last: expect.stringContaining('[shop] Deployed') });
    expect(existsSync(path.join(dir, 'api.blue'))).toBe(false);
    const all = await cli(['update', '-c', file, '--json']);
    const parsed = JSON.parse(all.out.slice(all.out.indexOf('{\n'))) as {
      workspaces: { name: string; outcome: string }[];
    };
    expect(parsed.workspaces.map(({ name, outcome }) => `${name} ${outcome}`)).toEqual([
      'shop up-to-date',
      'api deployed',
    ]);
    expect(readFileSync(path.join(dir, 'updater.state.shop.json'), 'utf8')).toContain(shop.head());
    const status = await cli(['status', '-c', file]);
    expect(status.out).toMatch(/\[shop\][\s\S]*\[api\][\s\S]*Live slot: blue/);
    expect(await cli(['status', '-c', file, '-w', 'nope'])).toMatchObject({
      code: 2,
      err: expect.stringContaining('The configuration has: shop, api'),
    });
    expect(await cli(['rollback', '-c', file])).toMatchObject({ code: 2, err: expect.stringContaining('--workspace') });
  });

  it('keeps going when one workspace breaks and exits with 1', async () => {
    const { dir, file } = project();
    writeFileSync(path.join(dir, 'shop'), 'a file where the checkout should be');
    const result = await cli(['update', '-c', file]);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/\[shop\] Update failed[\s\S]*\[api\] Deployed/);
  });

  it('starts a fleet until aborted', async () => {
    const { file } = project();
    const controller = new AbortController();
    const out: string[] = [];
    const running = runCli(['start', '-c', file, '--immediate'], {
      stdout: (line) => out.push(line),
      stderr: (line) => out.push(line),
      env: {},
      signal: controller.signal,
    });
    await expect.poll(() => out.filter((line) => line.includes('Update complete')).length, { timeout: 20_000 }).toBe(2);
    controller.abort();
    expect(await running).toBe(0);
    expect(out.join('\n')).toMatch(/workspace=shop/);
  });
});
