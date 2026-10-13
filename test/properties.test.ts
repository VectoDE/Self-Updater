// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { createHmac } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseEnvLine } from '../src/cli/run.js';
import { expandEnvironment } from '../src/config/load.js';
import { parseConfig } from '../src/config/schema.js';
import { Logger } from '../src/logger.js';
import { compareSemVer, newestTag, parseSemVer, tagMatcher } from '../src/semver.js';
import { verifyGitHubSignature } from '../src/webhook.js';

const numeric = fc.integer({ min: 0, max: 10_000 });
const identifier = fc.stringMatching(/^[0-9A-Za-z-]{1,8}$/).filter((part) => !/^0\d/.test(part));
const version = fc.record({
  major: numeric,
  minor: numeric,
  patch: numeric,
  prerelease: fc.array(identifier, { maxLength: 3 }),
});
const format = (v: { major: number; minor: number; patch: number; prerelease: string[] }) => {
  const suffix = v.prerelease.length > 0 ? `-${v.prerelease.join('.')}` : '';
  return `${v.major}.${v.minor}.${v.patch}${suffix}`;
};

describe('semver properties', () => {
  it('parses what it formats', () => {
    fc.assert(
      fc.property(version, fc.constantFrom('', 'v', 'release-'), (v, prefix) => {
        expect(parseSemVer(`${prefix}${format(v)}`)).toMatchObject({ major: v.major, minor: v.minor, patch: v.patch });
      })
    );
  });

  it('orders versions consistently', () => {
    fc.assert(
      fc.property(version, version, version, (a, b, c) => {
        const [pa, pb, pc] = [a, b, c].map((v) => parseSemVer(format(v))!);
        const ab = compareSemVer(pa!, pb!);
        expect(Math.sign(ab)).toBe(-Math.sign(compareSemVer(pb!, pa!)));
        if (ab <= 0 && compareSemVer(pb!, pc!) <= 0) {
          expect(compareSemVer(pa!, pc!)).toBeLessThanOrEqual(0);
        }
      })
    );
  });

  it('picks a tag no other candidate beats', () => {
    fc.assert(
      fc.property(fc.array(version, { minLength: 1, maxLength: 10 }), (versions) => {
        const tags = versions.map((v) => `v${format(v)}`);
        const newest = newestTag(tags, { pattern: 'v*', prerelease: true });
        expect(newest).toBeDefined();
        for (const tag of tags) {
          expect(compareSemVer(parseSemVer(tag)!, parseSemVer(newest!)!)).toBeLessThanOrEqual(0);
        }
      })
    );
  });

  it('treats pattern characters other than * literally', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }).filter((text) => !text.includes('*')),
        (literal) => {
          expect(tagMatcher(literal)(literal)).toBe(true);
          expect(tagMatcher(literal)(`${literal}x`)).toBe(false);
        }
      )
    );
  });
});

describe('robustness against arbitrary input', () => {
  it('never throws on any configuration value', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = parseConfig(value);
        expect(typeof result.ok).toBe('boolean');
      })
    );
  });

  it('leaves text without placeholders unchanged and replaces every set variable', () => {
    fc.assert(
      // An empty variable counts as missing, like an unset one.
      fc.property(
        fc.string().filter((text) => !text.includes('${')),
        fc.string({ minLength: 1 }),
        (text, value) => {
          expect(expandEnvironment(text, {})).toBe(text);
          expect(expandEnvironment(`a\${NAME}b`, { NAME: value })).toBe(`a${value}b`);
        }
      )
    );
  });

  it('reads any .env line without throwing', () => {
    fc.assert(
      fc.property(fc.string(), (line) => {
        const entry = parseEnvLine(line);
        if (entry) {
          expect(entry[0]).toMatch(/^[A-Z_]\w*$/i);
        }
      })
    );
  });

  it('never prints a secret', () => {
    // Quotes, backslashes and control characters included: JSON escapes them, which must not reveal the secret.
    const secrets = fc.string({ minLength: 4, maxLength: 30, unit: 'binary' }).filter((value) => !value.includes('*'));
    fc.assert(
      fc.property(secrets, fc.string(), (secret, around) => {
        const lines: string[] = [];
        const logger = new Logger({ secrets: [secret], write: (line) => lines.push(line), format: 'json' });
        logger.info(`${around}${secret}${around}`, { field: secret });
        expect(lines.join('')).not.toContain(JSON.stringify(secret).slice(1, -1));
      })
    );
  });

  it('accepts exactly the matching webhook signature', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 16 }), fc.uint8Array(), fc.string(), (secret, body, other) => {
        const data = Buffer.from(body);
        const valid = `sha256=${createHmac('sha256', secret).update(data).digest('hex')}`;
        expect(verifyGitHubSignature(secret, data, valid)).toBe(true);
        if (other !== secret) {
          const wrong = `sha256=${createHmac('sha256', other).update(data).digest('hex')}`;
          expect(verifyGitHubSignature(secret, data, wrong)).toBe(false);
        }
      })
    );
  });
});
