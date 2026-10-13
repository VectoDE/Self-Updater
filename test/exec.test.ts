// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { isSelfUpdaterError } from '../src/errors.js';
import { describeCommand, run, runChecked } from '../src/exec.js';
import { nodeScript, tempDir } from './helpers.js';

describe('run', () => {
  it('runs a program with arguments and no shell', async () => {
    const result = await run(
      ['node', '-e', 'process.stdout.write(process.argv[1] + "|" + process.cwd())', 'a; echo b'],
      {
        cwd: tempDir(),
      }
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^a; echo b\|/);
  });

  it('runs a command line through the shell with input and environment', async () => {
    const dir = tempDir();
    const command = nodeScript(
      dir,
      'echo.js',
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(s+process.env.EXTRA);process.stderr.write("warn");process.exit(3)})'
    );
    const result = await run(command, { input: 'hello ', env: { ...process.env, EXTRA: 'world' } });
    expect(result).toEqual({ code: 3, stdout: 'hello world', stderr: 'warn' });
  });

  it('stops a command that takes too long', async () => {
    const result = await run(['node', '-e', 'setTimeout(() => {}, 60000)'], { timeoutSeconds: 1 });
    expect(result.code).toBe(124);
    expect(result.stderr).toContain('Timed out after 1 s');
  });

  it('also stops what a shell command started', async () => {
    // The grandchild keeps the output pipe open; the run only ends if it is stopped as well.
    const script = nodeScript(
      tempDir(),
      'parent.js',
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }); setInterval(() => {}, 1000);"
    );
    const started = Date.now();
    const result = await run(script, { timeoutSeconds: 1 });
    expect(result.code).toBe(124);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('caps very long output', async () => {
    const result = await run(['node', '-e', 'process.stdout.write("x".repeat(3 * 1024 * 1024))']);
    expect(result.stdout).toHaveLength(1024 * 1024);
  });

  it('rejects when the program does not exist', async () => {
    await expect(run(['self-updater-no-such-program'])).rejects.toSatisfy(
      (error) => isSelfUpdaterError(error, 'COMMAND_FAILED') && error.message.includes('Could not start')
    );
  });
});

describe('runChecked', () => {
  it('returns the output of a successful command', async () => {
    expect((await runChecked(['node', '-e', 'console.log("ok")'])).stdout.trim()).toBe('ok');
  });

  it('throws with the last lines of error output', async () => {
    await expect(runChecked(['node', '-e', 'console.error("bad thing"); process.exit(2)'])).rejects.toThrow(
      /exited with 2: bad thing/
    );
    await expect(runChecked(['node', '-e', 'process.exit(1)'])).rejects.toThrow(/exited with 1$/);
  });
});

describe('describeCommand', () => {
  it('quotes arguments with spaces or quotes', () => {
    expect(describeCommand(['docker', 'restart', 'web'])).toBe('docker restart web');
    expect(describeCommand(['a b', "it's"])).toBe('"a b" "it\'s"');
    expect(describeCommand('npm ci && npm run build')).toBe('npm ci && npm run build');
  });
});
