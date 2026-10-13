// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { setTimeout as sleep } from 'node:timers/promises';
import type { HealthCheckConfig } from './config/schema.js';
import { messageOf, SelfUpdaterError } from './errors.js';
import { run } from './exec.js';
import { type Logger, silentLogger } from './logger.js';
import type { FetchLike } from './target.js';

export interface HealthCheckOptions {
  cwd: string;
  fetch?: FetchLike;
  logger?: Logger;
  /** Replaces the waits between attempts, for tests. */
  wait?: (seconds: number) => Promise<void>;
}

/** The URL without credentials and query string for messages: both may carry a token. */
const shown = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'the health URL';
  }
};

const attempt = async (check: HealthCheckConfig, options: HealthCheckOptions): Promise<string | undefined> => {
  if (check.url) {
    try {
      const response = await (options.fetch ?? fetch)(check.url, {
        signal: AbortSignal.timeout(check.timeoutSeconds * 1000),
        redirect: 'manual',
        headers: { 'User-Agent': 'self-updater' },
      });
      // Read and drop the body so the connection is released.
      await response.arrayBuffer().catch(() => undefined);
      if (response.status !== check.expectStatus) {
        return `${shown(check.url)} answered ${response.status}, expected ${check.expectStatus}`;
      }
    } catch (error) {
      // Some errors quote the full URL; keep only the shown part.
      return `${shown(check.url)} did not answer: ${messageOf(error).replaceAll(check.url, shown(check.url))}`;
    }
  }
  if (check.command) {
    const result = await run(check.command, { cwd: options.cwd, timeoutSeconds: check.timeoutSeconds });
    if (result.code !== 0) {
      const output = (result.stderr || result.stdout).trim().split('\n').slice(-5).join(' ');
      const detail = output ? `: ${output}` : '';
      return `health command exited with ${result.code}${detail}`;
    }
  }
  return undefined;
};

/**
 * Checks that the service works after a restart: the URL answers with the expected status and the command exits
 * with 0. Tries 1 + retries times and throws HEALTH_CHECK_FAILED with the last reason.
 */
export const checkHealth = async (check: HealthCheckConfig, options: HealthCheckOptions): Promise<number> => {
  const logger = options.logger ?? silentLogger;
  const wait = options.wait ?? ((seconds: number) => sleep(seconds * 1000));
  if (check.startDelaySeconds > 0) {
    await wait(check.startDelaySeconds);
  }
  const attempts = check.retries + 1;
  // One attempt after the other, each waiting for the previous one.
  const tryAttempt = async (number: number): Promise<number> => {
    const reason = await attempt(check, options);
    if (reason === undefined) {
      logger.info('Health check passed', { attempt: number });
      return number;
    }
    logger.warn('Health check failed', { attempt: number, of: attempts, reason });
    if (number >= attempts) {
      throw new SelfUpdaterError('HEALTH_CHECK_FAILED', `Health check failed ${attempts} times: ${reason}`);
    }
    await wait(check.intervalSeconds);
    return tryAttempt(number + 1);
  };
  return tryAttempt(1);
};
