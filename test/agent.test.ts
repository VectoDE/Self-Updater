// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/agent.js';
import type { UpdaterConfigInput } from '../src/config/schema.js';
import type { UpdateResult, Updater } from '../src/updater.js';
import { makeConfig, recordingLogger } from './helpers.js';

/** A stand-in for the Updater whose cycles the test releases one by one. */
const fakeUpdater = (fields: Partial<UpdaterConfigInput> = {}) => {
  const config = makeConfig({ repo: { url: '/srv/repo' }, workspace: { path: '/srv/app' }, ...fields });
  const gates: (() => void)[] = [];
  let outcome: UpdateResult | Error = { outcome: 'up-to-date' };
  const update = vi.fn(
    () =>
      new Promise<UpdateResult>((resolve, reject) => {
        gates.push(() => {
          if (outcome instanceof Error) reject(outcome);
          else resolve(outcome);
        });
      })
  );
  const release = async () => {
    // Let pending promise callbacks run so the agent reaches its next await.
    await vi.waitFor(() => {
      expect(gates.length).toBeGreaterThan(0);
    });
    gates.shift()?.();
  };
  return {
    updater: { config, update } as unknown as Updater,
    update,
    release,
    setOutcome: (next: UpdateResult | Error) => {
      outcome = next;
    },
  };
};

afterEach(() => {
  vi.useRealTimers();
});

describe('Agent', () => {
  it('runs right away when asked and collapses triggers during a cycle into one more', async () => {
    const { updater, update, release } = fakeUpdater();
    const cycles: (UpdateResult | Error)[] = [];
    const agent = new Agent(updater, { immediate: true, onCycle: (result) => cycles.push(result) });
    await agent.start();
    expect(update).toHaveBeenCalledTimes(1);
    const queued = [agent.trigger('a'), agent.trigger('b'), agent.trigger('c')];
    await release();
    await release();
    await Promise.all(queued);
    expect(update).toHaveBeenCalledTimes(2);
    expect(cycles).toHaveLength(2);
    await agent.stop();
  });

  it('reports failed cycles and errors and keeps going', async () => {
    const { updater, release, setOutcome } = fakeUpdater();
    const { logger, records } = recordingLogger();
    const cycles: (UpdateResult | Error)[] = [];
    const agent = new Agent(updater, { logger, onCycle: (result) => cycles.push(result) });
    await agent.start();
    setOutcome({ outcome: 'rolled-back', error: 'health check failed' });
    let done = agent.trigger('manual');
    await release();
    await done;
    setOutcome(new Error('network down'));
    done = agent.trigger('manual');
    await release();
    await done;
    expect(cycles[1]).toBeInstanceOf(Error);
    expect(records.map(({ message }) => message)).toEqual(
      expect.arrayContaining(['Update cycle ended without the new version', 'Update cycle failed'])
    );
    await agent.stop();
  });

  it('polls on the interval plus jitter', async () => {
    vi.useFakeTimers();
    const { updater, update, release } = fakeUpdater({ schedule: { intervalSeconds: 60, jitterSeconds: 10 } });
    const agent = new Agent(updater, { random: () => 0.5 });
    await agent.start();
    await vi.advanceTimersByTimeAsync(64_999);
    expect(update).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(update).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    await release();
    const stopping = agent.stop();
    await stopping;
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('waits for a running cycle when stopping and ignores triggers afterwards', async () => {
    const { updater, update, release } = fakeUpdater();
    const agent = new Agent(updater, { immediate: true });
    await agent.start();
    let stopped = false;
    const stopping = agent.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await release();
    await stopping;
    expect(stopped).toBe(true);
    await agent.trigger('late');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('starts the webhook and runs a cycle per accepted delivery', async () => {
    const secret = 'agent-secret-0123456789abcdefghijklm';
    const { updater, update, release } = fakeUpdater({
      webhook: { enabled: true, secret, port: 9000 },
      schedule: { enabled: false },
    });
    updater.config.webhook.port = 0;
    const agent = new Agent(updater);
    await agent.start();
    const port = agent.webhookPort;
    expect(port).toBeGreaterThan(0);
    const body = JSON.stringify({ ref: 'refs/heads/main' });
    const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    const response = await fetch(`http://127.0.0.1:${port}/hooks/self-updater`, {
      method: 'POST',
      headers: { 'x-github-event': 'push', 'x-hub-signature-256': signature },
      body,
    });
    expect(response.status).toBe(202);
    await release();
    await vi.waitFor(() => {
      expect(update).toHaveBeenCalledTimes(1);
    });
    await agent.stop();
    expect(agent.webhookPort).toBeUndefined();
  });
});
