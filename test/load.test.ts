// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { expandEnvironment, loadConfig, resolveConfigPath, statePathFor, writeJsonFile } from '../src/config/load.js';
import { isSelfUpdaterError } from '../src/errors.js';
import { tempDir } from './helpers.js';

describe('expandEnvironment', () => {
  it('replaces variables in nested strings', () => {
    const env = { TOKEN: 'abc', PORT: '8080' };
    expect(
      expandEnvironment(
        { a: '${TOKEN}', list: ['x-${PORT}', 3, true, null], nested: { b: '${MISSING:-fallback}' } },
        env
      )
    ).toEqual({ a: 'abc', list: ['x-8080', 3, true, null], nested: { b: 'fallback' } });
  });

  it('keeps escaped references and treats empty values as unset', () => {
    expect(expandEnvironment('$${TOKEN} ${EMPTY:-d}', { TOKEN: 'abc', EMPTY: '' })).toBe('${TOKEN} d');
    // A value is inserted as it is, even when it looks like an escape.
    expect(expandEnvironment('${SECRET}', { SECRET: 'a$${b' })).toBe('a$${b');
    expect(expandEnvironment('$$${X}', { X: 'v' })).toBe('$${X}');
  });

  it('lists every missing variable', () => {
    expect(() => expandEnvironment({ a: '${ONE}', b: ['${TWO}'] }, {})).toThrow(/ONE, TWO/);
  });
});

describe('loadConfig', () => {
  it('reads, validates and resolves paths relative to the file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'updater.config.json');
    writeFileSync(
      file,
      JSON.stringify({
        repo: { url: 'https://github.com/acme/app.git', token: '${GH}' },
        workspace: { path: 'app' },
        service: { type: 'none' },
        track: { allowedSigners: 'keys/allowed' },
        logging: { file: 'logs/updater.log' },
      })
    );
    const loaded = loadConfig(file, { GH: 'secret' });
    expect(loaded.path).toBe(file);
    expect(loaded.migrated).toBe(false);
    expect(loaded.config.repo.token).toBe('secret');
    expect(loaded.config.workspace.path).toBe(path.join(dir, 'app'));
    expect(loaded.config.logging.file).toBe(path.join(dir, 'logs', 'updater.log'));
    expect(loaded.config.track.allowedSigners).toBe(path.join(dir, 'keys', 'allowed'));
  });

  it('explains a missing, broken or invalid file', () => {
    const dir = tempDir();
    const file = path.join(dir, 'c.json');
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return isSelfUpdaterError(error) ? error.code : 'other';
      }
      return 'none';
    };
    expect(codeOf(() => loadConfig(file, {}))).toBe('CONFIG_NOT_FOUND');
    writeFileSync(file, '{ nope');
    expect(codeOf(() => loadConfig(file, {}))).toBe('CONFIG_INVALID');
    writeFileSync(file, JSON.stringify({ repo: {} }));
    expect(() => loadConfig(file, {})).toThrow(/repo\.url is required/);
  });

  it('finds the file from the option, the environment or the working directory', () => {
    expect(resolveConfigPath('x.json', {})).toBe(path.resolve('x.json'));
    expect(resolveConfigPath(undefined, { SELF_UPDATER_CONFIG: '/etc/su.json' })).toBe(path.resolve('/etc/su.json'));
    expect(resolveConfigPath(undefined, {})).toBe(path.resolve('updater.config.json'));
    expect(statePathFor('/etc/su/config.json')).toBe(path.join('/etc/su', 'updater.state.json'));
  });
});

describe('writeJsonFile', () => {
  it('creates folders and replaces the file in one step', async () => {
    const file = path.join(tempDir(), 'deep', 'state.json');
    await writeJsonFile(file, { a: 1 });
    await writeJsonFile(file, { a: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 });
    expect(existsSync(`${file}.${process.pid}.tmp`)).toBe(false);
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});
