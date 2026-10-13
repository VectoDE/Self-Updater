// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UpdaterConfig, WebhookConfig } from './config/schema.js';
import { projectPathOf } from './git.js';
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

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Checks GitLab's X-Gitlab-Token header, which carries the secret itself. Both sides are hashed first, so the
 * comparison takes the same time whatever the length of the guess and reveals nothing about the secret's length.
 */
export const verifyGitLabToken = (secret: string, header: string | undefined): boolean =>
  header !== undefined && timingSafeEqual(digest(secret), digest(header));

export type WebhookVerdict =
  | {
      accepted: true;
      reason: string;
      ref: string;
      /** owner/name of the repository that sent it, when the payload says. */
      repository?: string;
    }
  | { accepted: false; status: number; reason: string };

const header = (request: Pick<IncomingMessage, 'headers'>, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

type Rejection = Extract<WebhookVerdict, { accepted: false }>;

const reject = (status: number, reason: string): Rejection => ({ accepted: false, status, reason });

/** Checks who sent the delivery and whether its event type can carry a deployment; undefined means go on. */
const authenticate = (
  webhook: WebhookConfig,
  acceptsReleases: boolean,
  request: Pick<IncomingMessage, 'headers'>,
  body: Buffer
): Rejection | undefined => {
  const secret = webhook.secret ?? '';
  const githubEvent = header(request, 'x-github-event');
  if (githubEvent !== undefined) {
    if (!verifyGitHubSignature(secret, body, header(request, 'x-hub-signature-256'))) {
      return reject(401, 'signature does not match');
    }
    if (githubEvent === 'ping') {
      return reject(200, 'ping');
    }
    const relevant = githubEvent === 'push' || (githubEvent === 'release' && acceptsReleases);
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

interface Payload {
  ref?: unknown;
  release?: { tag_name?: unknown };
  repository?: { full_name?: unknown };
  project?: { path_with_namespace?: unknown };
}

/** The ref a push or release event is about, and the repository it came from. */
const refOf = (body: Buffer): { ref: string; repository?: string } | Rejection => {
  let payload: Payload;
  try {
    payload = JSON.parse(body.toString('utf8')) as Payload;
  } catch {
    return reject(400, 'body is not JSON');
  }
  // GitHub names the repository in repository.full_name, GitLab in project.path_with_namespace.
  const name = payload.repository?.full_name ?? payload.project?.path_with_namespace;
  const repository = typeof name === 'string' ? { repository: name } : {};
  if (typeof payload.ref === 'string') {
    return { ref: payload.ref, ...repository };
  }
  const tag = payload.release?.tag_name;
  return typeof tag === 'string' ? { ref: `refs/tags/${tag}`, ...repository } : reject(202, 'no ref in the payload');
};

/** Whether the delivery's repository is the configured one; true when either side does not say. */
export const isSameRepository = (config: UpdaterConfig, repository: string | undefined): boolean => {
  const configured = projectPathOf(config.repo.url);
  return !repository || !configured || configured.toLowerCase() === repository.toLowerCase();
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
  const rejection = authenticate(config.webhook, config.track.mode === 'tag', request, body);
  if (rejection) {
    return rejection;
  }
  const found = refOf(body);
  if (!('ref' in found)) {
    return found;
  }
  return isTrackedRef(config, found.ref)
    ? { accepted: true, reason: 'update scheduled', ...found }
    : reject(202, `${found.ref} is not tracked`);
};

/**
 * The configurations a delivery is for, when several workspaces share one receiver: same repository (when the
 * payload names it) and a tracked ref.
 */
export const workspacesFor = <T extends { config: UpdaterConfig }>(
  workspaces: readonly T[],
  verdict: Extract<WebhookVerdict, { accepted: true }>
): T[] =>
  workspaces.filter(({ config }) => isSameRepository(config, verdict.repository) && isTrackedRef(config, verdict.ref));

/** judgeDelivery for several workspaces behind one receiver with a shared secret. */
export const judgeSharedDelivery = (
  webhook: WebhookConfig,
  configs: readonly UpdaterConfig[],
  request: Pick<IncomingMessage, 'headers'>,
  body: Buffer
): WebhookVerdict => {
  const acceptsReleases = configs.some((config) => config.track.mode === 'tag');
  const rejection = authenticate(webhook, acceptsReleases, request, body);
  if (rejection) {
    return rejection;
  }
  const found = refOf(body);
  if (!('ref' in found)) {
    return found;
  }
  const verdict = { accepted: true as const, reason: 'update scheduled', ...found };
  return workspacesFor(
    configs.map((config) => ({ config })),
    verdict
  ).length > 0
    ? verdict
    : reject(202, `${found.ref} is not tracked`);
};

/** Compares a bearer token in constant time, whatever its length. */
const bearerMatches = (token: string, authorization: string | undefined): boolean =>
  authorization !== undefined && timingSafeEqual(digest(`Bearer ${token}`), digest(authorization));

export interface WebhookServer {
  server: Server;
  /** The port actually bound (useful with port 0). */
  port: number;
  close: () => Promise<void>;
}

export interface ReceiverOptions {
  logger?: Logger;
  /** What the status endpoint (webhook.statusPath) answers with; it is serialized as JSON. */
  status?: () => unknown;
}

type Accepted = Extract<WebhookVerdict, { accepted: true }>;

/**
 * Starts the HTTP endpoint for deliveries and, when webhook.statusPath is set, the status endpoint next to it.
 * judge decides on each delivery; onAccepted runs after the answer went out (the agents collapse bursts).
 */
export const startReceiver = async (
  webhook: WebhookConfig,
  judge: (request: IncomingMessage, body: Buffer) => WebhookVerdict,
  onAccepted: (verdict: Accepted) => void,
  options: ReceiverOptions = {}
): Promise<WebhookServer> => {
  const logger = options.logger ?? silentLogger;
  const server = createServer((request, response) => {
    const answer = (status: number, message: string) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(`${message}\n`);
    };
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (webhook.statusPath !== undefined && url.pathname === webhook.statusPath) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.setHeader('Allow', 'GET, HEAD');
        answer(405, 'use GET');
        return;
      }
      if (webhook.statusToken !== undefined && !bearerMatches(webhook.statusToken, header(request, 'authorization'))) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        answer(401, 'token does not match');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : `${JSON.stringify(options.status?.() ?? {}, null, 2)}\n`);
      return;
    }
    if (url.pathname !== webhook.path) {
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
      const verdict = judge(request, Buffer.concat(chunks));
      if (verdict.accepted) {
        logger.info('Webhook accepted', { ref: verdict.ref, repository: verdict.repository });
        answer(202, verdict.reason);
        onAccepted(verdict);
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
    server.listen(webhook.port, webhook.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  logger.info('Webhook listening', { host: webhook.host, port, path: webhook.path, status: webhook.statusPath });
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

/** Starts the endpoint for one workspace; onTrigger runs for every accepted delivery. */
export const startWebhookServer = (
  config: UpdaterConfig,
  onTrigger: (ref: string) => void,
  options: ReceiverOptions = {}
): Promise<WebhookServer> =>
  startReceiver(
    config.webhook,
    (request, body) => judgeDelivery(config, request, body),
    (verdict) => {
      onTrigger(verdict.ref);
    },
    options
  );
