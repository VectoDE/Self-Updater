// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { Agent, type AgentOptions, describeWorkspace, type WorkspaceStatus } from './agent.js';
import type { WebhookConfig } from './config/schema.js';
import { type Logger, silentLogger } from './logger.js';
import type { Updater } from './updater.js';
import { judgeSharedDelivery, startReceiver, type WebhookServer, workspacesFor } from './webhook.js';

export interface FleetMember {
  name: string;
  updater: Updater;
}

export interface FleetOptions extends Pick<AgentOptions, 'immediate' | 'random' | 'onCycle'> {
  logger?: Logger;
}

/**
 * Runs one agent per workspace of a configuration file and one webhook receiver for all of them. A delivery
 * reaches every workspace that follows its repository and ref; each agent polls on its own schedule.
 */
export class Fleet {
  readonly agents: { name: string; agent: Agent }[];
  private receiver: WebhookServer | undefined;
  private readonly logger: Logger;

  constructor(
    members: readonly FleetMember[],
    private readonly webhook: WebhookConfig,
    options: FleetOptions = {}
  ) {
    this.logger = options.logger ?? silentLogger;
    this.agents = members.map(({ name, updater }) => ({
      name,
      agent: new Agent(updater, { ...options, logger: this.logger.child({ workspace: name }), listen: false }),
    }));
  }

  /** The receiver's port when it runs (useful with port 0). */
  get webhookPort(): number | undefined {
    return this.receiver?.port;
  }

  status(): { workspaces: WorkspaceStatus[] } {
    return { workspaces: this.agents.map(({ name, agent }) => describeWorkspace(name, agent)) };
  }

  async start(): Promise<void> {
    if (this.webhook.enabled) {
      const members = this.agents.map((entry) => ({ ...entry, config: entry.agent.updater.config }));
      this.receiver = await startReceiver(
        this.webhook,
        (request, body) =>
          judgeSharedDelivery(
            this.webhook,
            members.map(({ config }) => config),
            request,
            body
          ),
        (verdict) => {
          for (const { agent } of workspacesFor(members, verdict)) {
            void agent.trigger(`webhook ${verdict.ref}`);
          }
        },
        { logger: this.logger, status: () => this.status() }
      );
    }
    await Promise.all(this.agents.map(({ agent }) => agent.start()));
  }

  /** Stops the receiver, then every agent; running deployments finish first. */
  async stop(): Promise<void> {
    await this.receiver?.close();
    this.receiver = undefined;
    await Promise.all(this.agents.map(({ agent }) => agent.stop()));
  }
}
