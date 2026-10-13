// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import type { HealthCheckConfig } from '../src/config/schema.js';
import { isSelfUpdaterError } from '../src/errors.js';
import { checkHealth } from '../src/health.js';
import { nodeScript, recordingLogger, startServer, tempDir } from './helpers.js';

const check = (fields: Partial<HealthCheckConfig>): HealthCheckConfig => ({
  expectStatus: 200,
  timeoutSeconds: 5,
  retries: 2,
  intervalSeconds: 1,
  startDelaySeconds: 0,
  ...fields,
});

describe('checkHealth', () => {
  it('passes when the URL answers with the expected status, after retries', async () => {
    let calls = 0;
    const server = await startServer((_, response) => {
      calls++;
      response.writeHead(calls < 3 ? 503 : 200).end('ok');
    });
    const waits: number[] = [];
    const { logger, records } = recordingLogger();
    const attempts = await checkHealth(check({ url: server.url, startDelaySeconds: 4 }), {
      cwd: tempDir(),
      logger,
      wait: (seconds) => {
        waits.push(seconds);
        return Promise.resolve();
      },
    });
    expect(attempts).toBe(3);
    expect(waits).toEqual([4, 1, 1]);
    expect(records.filter(({ level }) => level === 'warn')).toHaveLength(2);
  });

  it('fails with the last reason after all attempts', async () => {
    const server = await startServer((_, response) => response.writeHead(302, { Location: '/elsewhere' }).end());
    await expect(
      checkHealth(check({ url: server.url, retries: 1 }), { cwd: tempDir(), wait: () => Promise.resolve() })
    ).rejects.toSatisfy(
      (error) =>
        isSelfUpdaterError(error, 'HEALTH_CHECK_FAILED') && error.message.includes('answered 302, expected 200')
    );
  });

  it('leaves credentials and the query string out of the reason', async () => {
    const server = await startServer((_, response) => response.writeHead(500).end());
    const url = `${server.url}/health?token=s3cr3t-value`;
    await expect(checkHealth(check({ url, retries: 0 }), { cwd: tempDir() })).rejects.toSatisfy(
      (error) =>
        error instanceof Error &&
        error.message.includes(`${server.url}/health answered 500`) &&
        !error.message.includes('s3cr3t')
    );
    // fetch quotes the whole URL in some errors.
    const failing = (): Promise<Response> => Promise.reject(new Error(`cannot reach ${url}`));
    await expect(checkHealth(check({ url, retries: 0 }), { cwd: tempDir(), fetch: failing })).rejects.toSatisfy(
      (error) => error instanceof Error && !error.message.includes('s3cr3t')
    );
  });

  it('names an unparsable URL without quoting it', async () => {
    await expect(checkHealth(check({ url: 'not a url', retries: 0 }), { cwd: tempDir() })).rejects.toThrow(
      /^Health check failed 1 times: the health URL did not answer/
    );
  });

  it('reports a URL that does not answer', async () => {
    await expect(checkHealth(check({ url: 'http://127.0.0.1:1/', retries: 0 }), { cwd: tempDir() })).rejects.toThrow(
      /did not answer/
    );
  });

  it('runs the command in the workspace and checks its exit code', async () => {
    const dir = tempDir();
    const good = nodeScript(dir, 'good.js', 'process.exit(require("fs").existsSync("marker") ? 0 : 1)');
    await expect(checkHealth(check({ command: good, retries: 0 }), { cwd: dir })).rejects.toThrow(/exited with 1$/);
    nodeScript(dir, 'marker', '');
    expect(await checkHealth(check({ command: good, retries: 0 }), { cwd: dir })).toBe(1);
    const noisy = nodeScript(dir, 'noisy.js', 'console.error("db down"); process.exit(4)');
    await expect(checkHealth(check({ command: noisy, retries: 0 }), { cwd: dir })).rejects.toThrow(
      /exited with 4: db down/
    );
  });

  it('needs both URL and command to pass when both are set', async () => {
    const server = await startServer((_, response) => response.writeHead(200).end());
    const dir = tempDir();
    const bad = nodeScript(dir, 'bad.js', 'process.exit(1)');
    await expect(checkHealth(check({ url: server.url, command: bad, retries: 0 }), { cwd: dir })).rejects.toThrow(
      /health command/
    );
  });

  it('uses the injected fetch', async () => {
    const result = await checkHealth(check({ url: 'https://example.invalid/health', expectStatus: 204 }), {
      cwd: tempDir(),
      fetch: () => Promise.resolve(new Response(null, { status: 204 })),
    });
    expect(result).toBe(1);
  });
});
