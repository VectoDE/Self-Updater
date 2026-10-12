import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { parseConfig, type UpdaterConfig, type UpdaterConfigInput } from '../src/config/schema.js';
import { Logger, type LogRecord } from '../src/logger.js';

const cleanup: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) {
    await task();
  }
});

/** A temporary directory that is removed after the test. */
export const tempDir = (prefix = 'su-'): string => {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return dir;
};

export const onCleanup = (task: () => void | Promise<void>): void => {
  cleanup.push(task);
};

/** Forward slashes work in Node and in both shells, and need no escaping in a command line. */
export const slash = (file: string): string => file.replaceAll('\\', '/');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', ...args],
    {
      cwd,
      env: GIT_ENV,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  ).trim();

/** A repository that plays the remote: a working copy whose path serves as the clone URL. */
export class Remote {
  readonly dir: string;

  constructor() {
    this.dir = tempDir('su-remote-');
    git(this.dir, 'init', '--quiet');
    this.commit({ 'README.md': 'first\n' }, 'Initial commit');
  }

  get url(): string {
    return this.dir;
  }

  /** Writes files, commits them on the current branch and returns the commit. */
  commit(files: Record<string, string>, message = 'Change'): string {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(this.dir, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    git(this.dir, 'add', '--all');
    git(this.dir, 'commit', '--quiet', '--allow-empty', '-m', message);
    return this.head();
  }

  head(): string {
    return git(this.dir, 'rev-parse', 'HEAD');
  }

  tag(name: string): void {
    git(this.dir, 'tag', name);
  }

  annotatedTag(name: string): void {
    git(this.dir, 'tag', '-a', name, '-m', name);
  }
}

/** A complete configuration with test defaults, validated like a real file. */
export const makeConfig = (
  input: Partial<UpdaterConfigInput> & Pick<UpdaterConfigInput, 'repo' | 'workspace'>
): UpdaterConfig => {
  const result = parseConfig({ service: { type: 'none' }, ...input });
  if (!result.ok) {
    throw new Error(`Test configuration invalid: ${JSON.stringify(result.issues)}`);
  }
  return result.config;
};

/** A logger that keeps its records for assertions. */
export const recordingLogger = (secrets: string[] = []): { logger: Logger; records: LogRecord[]; lines: string[] } => {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  const logger = new Logger({
    level: 'debug',
    format: 'json',
    secrets,
    write: (line) => {
      lines.push(line);
      const parsed = JSON.parse(line) as { time: string; level: LogRecord['level']; message: string };
      const { time, level, message, ...fields } = parsed;
      records.push({ time, level, message, fields });
    },
  });
  return { logger, records, lines };
};

export interface Received {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

/** A local HTTP server whose answers the test decides. */
export const startServer = async (
  handler: (request: Received, response: ServerResponse) => void
): Promise<{ url: string; requests: Received[] }> => {
  const requests: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const received = {
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(received);
      handler(received, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  onCleanup(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      })
  );
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests };
};

/** Writes a Node script into a directory and returns a command line that runs it. */
export const nodeScript = (dir: string, name: string, source: string): string => {
  const file = path.join(dir, name);
  writeFileSync(file, source);
  return `node "${slash(file)}"`;
};
