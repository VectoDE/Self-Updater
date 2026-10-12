import { createHmac } from 'node:crypto';
import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { UpdaterConfigInput } from '../src/config/schema.js';
import {
  isTrackedRef,
  judgeDelivery,
  startWebhookServer,
  verifyGitHubSignature,
  verifyGitLabToken,
} from '../src/webhook.js';
import { makeConfig, onCleanup, recordingLogger } from './helpers.js';

const SECRET = 'webhook-secret-0123456789';

const configWith = (fields: Partial<UpdaterConfigInput> = {}) =>
  makeConfig({
    repo: { url: 'https://github.com/acme/app.git' },
    workspace: { path: '/srv/app' },
    webhook: { enabled: true, secret: SECRET },
    ...fields,
  });

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const github = (event: string, payload: unknown, signature?: string) => {
  const body = JSON.stringify(payload);
  return {
    request: { headers: { 'x-github-event': event, 'x-hub-signature-256': signature ?? sign(body) } },
    body: Buffer.from(body),
  };
};

describe('signature checks', () => {
  it('accepts only the right HMAC and token', () => {
    const body = Buffer.from('{}');
    expect(verifyGitHubSignature(SECRET, body, sign('{}'))).toBe(true);
    expect(verifyGitHubSignature(SECRET, body, sign('{}', 'other-secret-0123456'))).toBe(false);
    expect(verifyGitHubSignature(SECRET, body, 'sha256=abc')).toBe(false);
    expect(verifyGitHubSignature(SECRET, body, 'sha1=abc')).toBe(false);
    expect(verifyGitHubSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyGitLabToken(SECRET, SECRET)).toBe(true);
    expect(verifyGitLabToken(SECRET, `${SECRET}x`)).toBe(false);
    expect(verifyGitLabToken(SECRET, undefined)).toBe(false);
  });
});

describe('judgeDelivery', () => {
  const config = configWith();

  it('accepts a signed push to the tracked branch', () => {
    const { request: req, body } = github('push', { ref: 'refs/heads/main' });
    expect(judgeDelivery(config, req, body)).toEqual({
      accepted: true,
      reason: 'update scheduled',
      ref: 'refs/heads/main',
    });
  });

  it('rejects or ignores everything else', () => {
    const cases: [ReturnType<typeof github>, number, RegExp][] = [
      [github('push', { ref: 'refs/heads/main' }, sign('other')), 401, /signature/],
      [github('ping', { zen: 'hi' }), 200, /ping/],
      [github('issues', {}), 202, /event issues ignored/],
      [github('release', { release: { tag_name: 'v1.0.0' } }), 202, /event release ignored/],
      [github('push', { ref: 'refs/heads/dev' }), 202, /refs\/heads\/dev is not tracked/],
      [github('push', { before: 'x' }), 202, /no ref/],
    ];
    for (const [{ request: req, body }, status, reason] of cases) {
      const verdict = judgeDelivery(config, req, body);
      expect(verdict).toMatchObject({ accepted: false, status });
      expect(verdict.reason).toMatch(reason);
    }
    const broken = '{not json';
    expect(
      judgeDelivery(
        config,
        { headers: { 'x-github-event': 'push', 'x-hub-signature-256': sign(broken) } },
        Buffer.from(broken)
      )
    ).toMatchObject({ status: 400, reason: 'body is not JSON' });
    expect(judgeDelivery(config, { headers: {} }, Buffer.from('{}'))).toMatchObject({ status: 400 });
  });

  it('handles GitLab tokens and events', () => {
    const body = Buffer.from(JSON.stringify({ ref: 'refs/heads/main' }));
    const headers = (event: string, token = SECRET) => ({
      headers: { 'x-gitlab-event': event, 'x-gitlab-token': [token] },
    });
    expect(judgeDelivery(config, headers('Push Hook'), body)).toMatchObject({ accepted: true });
    expect(judgeDelivery(config, headers('Push Hook', 'wrong'), body)).toMatchObject({ status: 401 });
    expect(judgeDelivery(config, headers('Note Hook'), body)).toMatchObject({ status: 202 });
  });

  it('follows matching tags and releases in tag mode', () => {
    const tags = configWith({ track: { mode: 'tag', tagPattern: 'v*' } });
    const release = github('release', { action: 'published', release: { tag_name: 'v2.0.0' } });
    expect(judgeDelivery(tags, release.request, release.body)).toMatchObject({
      accepted: true,
      ref: 'refs/tags/v2.0.0',
    });
    expect(isTrackedRef(tags, 'refs/tags/v2.0.0')).toBe(true);
    expect(isTrackedRef(tags, 'refs/tags/nightly')).toBe(false);
    expect(isTrackedRef(tags, 'refs/heads/main')).toBe(false);
    expect(isTrackedRef(config, 'refs/heads/main')).toBe(true);
  });
});

describe('startWebhookServer', () => {
  const start = async () => {
    const config = configWith();
    config.webhook.port = 0;
    const triggers: string[] = [];
    const { logger, records } = recordingLogger();
    const hook = await startWebhookServer(config, (ref) => triggers.push(ref), { logger });
    onCleanup(hook.close);
    const send = (method: string, path: string, body = '', headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${hook.port}${path}`, { method, headers, ...(method === 'POST' ? { body } : {}) });
    return { hook, triggers, records, send };
  };

  it('answers deliveries and triggers updates for accepted ones', async () => {
    const { triggers, records, send } = await start();
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const accepted = await send('POST', '/hooks/self-updater?x=1', body, {
      'x-github-event': 'push',
      'x-hub-signature-256': sign(body),
    });
    expect(accepted.status).toBe(202);
    expect(accepted.headers.get('cache-control')).toBe('no-store');
    expect(await accepted.text()).toBe('update scheduled\n');
    expect(triggers).toEqual(['refs/heads/main']);

    expect(
      (
        await send('POST', '/hooks/self-updater', body, {
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=00',
        })
      ).status
    ).toBe(401);
    expect(records.some(({ message }) => message === 'Webhook rejected')).toBe(true);
    expect(
      (await send('POST', '/hooks/self-updater', body, { 'x-github-event': 'ping', 'x-hub-signature-256': sign(body) }))
        .status
    ).toBe(200);
    expect((await send('GET', '/')).status).toBe(404);
    const get = await send('GET', '/hooks/self-updater');
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toBe('POST');
    expect(triggers).toHaveLength(1);
  });

  it('refuses bodies over one megabyte', async () => {
    const { hook, triggers } = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: hook.port,
          path: '/hooks/self-updater',
          method: 'POST',
          headers: { 'x-github-event': 'push' },
        },
        (response) => {
          resolve(response.statusCode ?? 0);
          response.resume();
        }
      );
      req.on('error', reject);
      req.end(Buffer.alloc(2 * 1024 * 1024, 'a'));
    }).catch(() => 413);
    expect(status).toBe(413);
    expect(triggers).toHaveLength(0);
  });

  it('fails to start when the port is taken', async () => {
    const { hook } = await start();
    const config = configWith();
    config.webhook.port = hook.port;
    await expect(startWebhookServer(config, () => undefined)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});
