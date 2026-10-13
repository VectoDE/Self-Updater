// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { SelfUpdaterError } from './errors.js';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutSeconds?: number;
  /** Text passed to the process on standard input. */
  input?: string;
  /** Name for the command in error messages, instead of its text (which may hold credentials). */
  label?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT = 1024 * 1024;

/**
 * Stops a command and everything it started: the process group on POSIX, the process tree through taskkill on
 * Windows, which has no process groups.
 */
const stop = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) {
    return;
  }
  if (process.platform === 'win32') {
    // A fixed path, not a lookup through PATH.
    const taskkill = path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'taskkill.exe');
    spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => undefined
    );
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
};

const append = (current: string, chunk: Buffer) =>
  current.length >= MAX_OUTPUT ? current : (current + chunk.toString('utf8')).slice(0, MAX_OUTPUT);

/**
 * Runs a program. With a list of arguments no shell is involved, so names and refs from the configuration cannot
 * inject commands. A string runs through the system shell: that is what hooks and custom commands are for, and they
 * come from the operator's own configuration file.
 */
export const run = (command: string | readonly [string, ...string[]], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve, reject) => {
    const shell = typeof command === 'string';
    const [file, ...args] = shell ? [command] : command;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell,
      windowsHide: true,
      // Own process group on POSIX, so a timeout also stops whatever a hook started.
      detached: process.platform !== 'win32',
      stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer =
      options.timeoutSeconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop(child.pid, 'SIGTERM');
            // A process that ignores SIGTERM is stopped for good after five seconds.
            setTimeout(() => {
              stop(child.pid, 'SIGKILL');
            }, 5000).unref();
          }, options.timeoutSeconds * 1000);
    child.stdout?.on('data', (chunk: Buffer) => (stdout = append(stdout, chunk)));
    child.stderr?.on('data', (chunk: Buffer) => (stderr = append(stderr, chunk)));
    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new SelfUpdaterError('COMMAND_FAILED', `Could not start ${file}: ${error.message}`, { cause: error }));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ code: 124, stdout, stderr: `${stderr}\nTimed out after ${options.timeoutSeconds} s`.trim() });
        return;
      }
      resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
    });
  });

/** A short, readable form of a command for logs and error messages. */
export const describeCommand = (command: string | readonly string[]): string =>
  typeof command === 'string'
    ? command
    : command.map((part) => (/[\s"']/.test(part) ? JSON.stringify(part) : part)).join(' ');

/** Runs a program and throws COMMAND_FAILED with its error output when it does not exit with 0. */
export const runChecked = async (
  command: string | readonly [string, ...string[]],
  options: RunOptions = {}
): Promise<RunResult> => {
  const result = await run(command, options);
  if (result.code !== 0) {
    const output = (result.stderr || result.stdout).trim().split('\n').slice(-20).join('\n');
    const detail = output ? `: ${output}` : '';
    throw new SelfUpdaterError(
      'COMMAND_FAILED',
      `${options.label ?? describeCommand(command)} exited with ${result.code}${detail}`
    );
  }
  return result;
};
