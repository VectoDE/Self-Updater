import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UpdaterConfig } from './config/schema.js';
import { type Logger, silentLogger } from './logger.js';
import { tagMatcher } from './semver.js';

const MAX_BODY = 1024 * 1024;

const sameBytes = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Checks GitHub's X-Hub-Signature-256 header: HMAC-SHA256 of the raw body with the shared secret. */
export const verifyGitHubSignature = (secret: string, body: Buffer, header: string | undefined): boolean => {
  if (!header?.startsWith('sha256=')) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(header.slice('sha256='.length), 'hex');
  return sameBytes(expected, given);
};

/** Checks GitLab's X-Gitlab-Token header, which carries the secret itself. */
export const verifyGitLabToken = (secret: string, header: string | undefined): boolean =>
  header !== undefined && sameBytes(Buffer.from(secret), Buffer.from(header));

export type WebhookVerdict =
  { accepted: true; reason: string; ref: string } | { accepted: false; status: number; reason: string };

const header = (request: Pick<IncomingMessage, 'headers'>, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

type Rejection = Extract<WebhookVerdict, { accepted: false }>;

const reject = (status: number, reason: string): Rejection => ({ accepted: false, status, reason });

/** Checks who sent the delivery and whether its event type can carry a deployment; undefined means go on. */
const authenticate = (
  config: UpdaterConfig,
  request: Pick<IncomingMessage, 'headers'>,
  body: Buffer
): Rejection | undefined => {
  const secret = config.webhook.secret ?? '';
  const githubEvent = header(request, 'x-github-event');
  if (githubEvent !== undefined) {
    if (!verifyGitHubSignature(secret, body, header(request, 'x-hub-signature-256'))) {
      return reject(401, 'signature does not match');
    }
    if (githubEvent === 'ping') {
      return reject(200, 'ping');
    }
    const relevant = githubEvent === 'push' || (githubEvent === 'release' && config.track.mode === 'tag');
    return relevant ? undefined : reject(202, `event ${githubEvent} ignored`);
  }
  const gitlabEvent = header(request, 'x-gitlab-event');
  if (gitlabEvent !== undefined) {
    if (!verifyGitLabToken(secret, header(request, 'x-gitlab-token'))) {
      return reject(401, 'token does not match');
    }
    const relevant = gitlabEvent === 'Push Hook' || gitlabEvent === 'Tag Push Hook';
    return relevant ? undefined : reject(202, `event ${gitlabEvent} ignored`);
  }
  return reject(400, 'not a GitHub or GitLab webhook');
};

/** The ref a push or release event is about. */
const refOf = (body: Buffer): { ref: string } | Rejection => {
  let payload: { ref?: unknown; release?: { tag_name?: unknown } };
  try {
    payload = JSON.parse(body.toString('utf8')) as typeof payload;
  } catch {
    return reject(400, 'body is not JSON');
  }
  if (typeof payload.ref === 'string') {
    return { ref: payload.ref };
  }
  const tag = payload.release?.tag_name;
  return typeof tag === 'string' ? { ref: `refs/tags/${tag}` } : reject(202, 'no ref in the payload');
};

/** Whether a ref is the tracked branch, or a tag matching the pattern in tag mode. */
export const isTrackedRef = (config: UpdaterConfig, ref: string): boolean => {
  if (config.track.mode === 'tag') {
    return ref.startsWith('refs/tags/') && tagMatcher(config.track.tagPattern)(ref.slice('refs/tags/'.length));
  }
  return ref === `refs/heads/${config.repo.branch}`;
};

/**
 * Decides whether a webhook delivery should start an update: the signature or token must match, and the event must
 * be a push to the tracked branch, or of a tag matching the pattern in tag mode. Pings are answered but ignored.
 */
export const judgeDelivery = (
  config: UpdaterConfig,
  request: Pick<IncomingMessage, 'headers'>,
  body: Buffer
): WebhookVerdict => {
  const rejection = authenticate(config, request, body);
  if (rejection) {
    return rejection;
  }
  const found = refOf(body);
  if (!('ref' in found)) {
    return found;
  }
  const { ref } = found;
  return isTrackedRef(config, ref)
    ? { accepted: true, reason: 'update scheduled', ref }
    : reject(202, `${ref} is not tracked`);
};

export interface WebhookServer {
  server: Server;
  /** The port actually bound (useful with port 0). */
  port: number;
  close: () => Promise<void>;
}

/** Starts the HTTP endpoint; onTrigger runs for every accepted delivery (the agent collapses bursts). */
export const startWebhookServer = async (
  config: UpdaterConfig,
  onTrigger: (ref: string) => void,
  options: { logger?: Logger } = {}
): Promise<WebhookServer> => {
  const logger = options.logger ?? silentLogger;
  const server = createServer((request, response) => {
    const answer = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`${message}\n`);
    };
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== config.webhook.path) {
      answer(404, 'not found');
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      answer(405, 'use POST');
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        answer(413, 'payload too large');
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) {
        return;
      }
      const verdict = judgeDelivery(config, request, Buffer.concat(chunks));
      if (verdict.accepted) {
        logger.info('Webhook accepted', { ref: verdict.ref });
        answer(202, verdict.reason);
        onTrigger(verdict.ref);
        return;
      }
      if (verdict.status === 401) {
        logger.warn('Webhook rejected', { reason: verdict.reason, from: request.socket.remoteAddress });
      } else {
        logger.debug('Webhook ignored', { reason: verdict.reason });
      }
      answer(verdict.status, verdict.reason);
    });
    request.on('error', () => undefined);
  });
  // Slow clients must not hold connections open forever.
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.webhook.port, config.webhook.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  logger.info('Webhook listening', { host: config.webhook.host, port, path: config.webhook.path });
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};
