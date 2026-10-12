import os from 'node:os';
import type { NotificationConfig, NotificationEvent } from './config/schema.js';
import { messageOf } from './errors.js';
import { type Logger, silentLogger } from './logger.js';
import type { FetchLike } from './target.js';

/** What happened in an update, as sent to generic webhooks. */
export interface DeploymentEvent {
  event: NotificationEvent;
  repository: string;
  ref: string;
  /** Commit that runs now. */
  commit?: string;
  /** Commit that ran before the update. */
  previousCommit?: string;
  /** Commit that failed, for failure and rollback. */
  failedCommit?: string;
  error?: string;
  host: string;
  time: string;
}

const short = (sha?: string) => sha?.slice(0, 12) ?? 'unknown';

/** One line a person can read in a chat. */
export const summarize = (event: DeploymentEvent): string => {
  const where = `${event.repository} (${event.ref}) on ${event.host}`;
  switch (event.event) {
    case 'success':
      return `Deployed ${short(event.commit)} of ${where}.`;
    case 'rollback':
      return `Deployment of ${short(event.failedCommit)} failed on ${where}; rolled back to ${short(event.commit)}. ${event.error ?? ''}`.trim();
    default:
      return `Deployment of ${short(event.failedCommit)} failed on ${where}. ${event.error ?? ''}`.trim();
  }
};

/** Request body for each notification type. */
export const payloadFor = (type: NotificationConfig['type'], event: DeploymentEvent): unknown => {
  const text = summarize(event);
  if (type === 'slack') {
    return { text };
  }
  if (type === 'discord') {
    // Discord rejects messages over 2000 characters.
    return { content: text.slice(0, 2000), allowed_mentions: { parse: [] } };
  }
  return { ...event, text };
};

export const createEvent = (
  fields: Omit<DeploymentEvent, 'host' | 'time'> & Partial<Pick<DeploymentEvent, 'host' | 'time'>>
): DeploymentEvent => ({ host: os.hostname(), time: new Date().toISOString(), ...fields });

/**
 * Sends the event to every target that subscribed to it. A failed notification is logged and never fails the
 * update itself.
 */
export const notify = async (
  targets: readonly NotificationConfig[],
  event: DeploymentEvent,
  options: { fetch?: FetchLike; logger?: Logger } = {}
): Promise<number> => {
  const logger = options.logger ?? silentLogger;
  const fetchImpl = options.fetch ?? fetch;
  const results = await Promise.all(
    targets
      .filter((target) => target.events.includes(event.event))
      .map(async (target) => {
        try {
          const response = await fetchImpl(target.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'self-updater' },
            body: JSON.stringify(payloadFor(target.type, event)),
            signal: AbortSignal.timeout(10_000),
          });
          await response.arrayBuffer().catch(() => undefined);
          if (!response.ok) {
            throw new Error(`answered ${response.status}`);
          }
          return true;
        } catch (error) {
          logger.warn('Notification failed', { type: target.type, error: messageOf(error) });
          return false;
        }
      })
  );
  return results.filter(Boolean).length;
};
