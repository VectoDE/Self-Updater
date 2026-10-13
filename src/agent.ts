// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { messageOf } from './errors.js';
import { type Logger, silentLogger } from './logger.js';
import type { UpdateResult, Updater } from './updater.js';
import { startWebhookServer, type WebhookServer } from './webhook.js';

export interface AgentOptions {
  logger?: Logger;
  /** Run a cycle right after start instead of waiting for the first interval. */
  immediate?: boolean;
  /** Random number in [0, 1) for the jitter; injectable for tests. */
  random?: () => number;
  /** Called after every cycle, with the result or the error. */
  onCycle?: (result: UpdateResult | Error) => void;
}

/**
 * Keeps one workspace up to date: polls on a schedule and/or reacts to webhooks. Cycles never overlap; triggers that
 * arrive during a cycle collapse into one follow-up cycle.
 */
export class Agent {
  private timer: NodeJS.Timeout | undefined;
  private webhook: WebhookServer | undefined;
  private running: Promise<void> | undefined;
  private pending = false;
  private stopped = false;
  private readonly logger: Logger;

  constructor(
    private readonly updater: Updater,
    private readonly options: AgentOptions = {}
  ) {
    this.logger = options.logger ?? silentLogger;
  }

  /** The webhook port when the webhook runs (useful with port 0). */
  get webhookPort(): number | undefined {
    return this.webhook?.port;
  }

  async start(): Promise<void> {
    const { config } = this.updater;
    this.stopped = false;
    if (config.webhook.enabled) {
      this.webhook = await startWebhookServer(
        config,
        (ref) => {
          void this.trigger(`webhook ${ref}`);
        },
        { logger: this.logger }
      );
    }
    this.logger.info('Agent started', {
      mode: config.track.mode,
      ref: config.track.mode === 'tag' ? config.track.tagPattern : config.repo.branch,
      polling: config.schedule.enabled ? `${config.schedule.intervalSeconds}s` : 'off',
      webhook: config.webhook.enabled ? 'on' : 'off',
    });
    if (this.options.immediate) {
      void this.trigger('start');
    } else {
      this.schedule();
    }
  }

  /** Asks for a cycle now; returns when it (or the one already running plus its follow-up) is done. */
  trigger(reason: string): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    if (this.running !== undefined) {
      this.pending = true;
      this.logger.debug('Cycle already running, queued another', { reason });
      return this.running;
    }
    clearTimeout(this.timer);
    this.running = this.loop(reason).finally(() => {
      this.running = undefined;
      this.schedule();
    });
    return this.running;
  }

  private async loop(reason: string): Promise<void> {
    this.pending = false;
    await this.cycle(reason);
    if (this.shouldRunAgain()) {
      await this.loop('queued trigger');
    }
  }

  // A method rather than an inline check: trigger() sets the flag while cycle() is awaited.
  private shouldRunAgain(): boolean {
    return this.pending && !this.stopped;
  }

  private async cycle(reason: string): Promise<void> {
    this.logger.debug('Update cycle', { reason });
    try {
      const result = await this.updater.update();
      this.options.onCycle?.(result);
      if (result.outcome === 'failed' || result.outcome === 'rolled-back') {
        this.logger.error('Update cycle ended without the new version', {
          outcome: result.outcome,
          error: result.error,
        });
      }
    } catch (error) {
      // Network or git trouble: log it and try again at the next interval.
      this.logger.error('Update cycle failed', { error: messageOf(error) });
      this.options.onCycle?.(error instanceof Error ? error : new Error(messageOf(error)));
    }
  }

  private schedule(): void {
    const { schedule } = this.updater.config;
    if (this.stopped || !schedule.enabled) {
      return;
    }
    clearTimeout(this.timer);
    const jitter = Math.floor((this.options.random ?? Math.random)() * schedule.jitterSeconds * 1000);
    this.timer = setTimeout(() => void this.trigger('schedule'), schedule.intervalSeconds * 1000 + jitter);
  }

  /** Stops polling and the webhook, then waits for a running cycle to finish (a deployment is never cut off). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.webhook?.close();
    this.webhook = undefined;
    await this.running;
    this.logger.info('Agent stopped');
  }
}
