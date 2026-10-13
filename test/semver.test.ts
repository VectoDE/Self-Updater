// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { compareSemVer, newestTag, parseSemVer, tagMatcher } from '../src/semver.js';

describe('parseSemVer', () => {
  it('reads versions with and without prefix', () => {
    expect(parseSemVer('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] });
    expect(parseSemVer('v10.0.1-rc.1')).toEqual({ major: 10, minor: 0, patch: 1, prerelease: ['rc', 1] });
    expect(parseSemVer('release-2.0.0+build.7')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] });
    expect(parseSemVer('v1.0.0-alpha-beta.0a')).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: ['alpha-beta', '0a'],
    });
  });

  it('rejects what is not a version', () => {
    for (const text of [
      'latest',
      '1.2',
      '1.2.3.4',
      '01.2.3',
      '1.2.3-01',
      '1.2.3-',
      '1.2.3-a..b',
      '1.2.3+',
      '1.2.3+a+b',
      '1.2.3+a_b',
      'x'.repeat(40) + '1.0.0',
    ]) {
      expect(parseSemVer(text), text).toBeUndefined();
    }
  });
});

describe('compareSemVer', () => {
  it('orders versions as the specification does', () => {
    const ordered = [
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
    ].map((text) => parseSemVer(text)!);
    for (let index = 1; index < ordered.length; index++) {
      expect(compareSemVer(ordered[index - 1]!, ordered[index]!)).toBe(-1);
      expect(compareSemVer(ordered[index]!, ordered[index - 1]!)).toBe(1);
    }
    expect(compareSemVer(parseSemVer('1.0.0+a')!, parseSemVer('v1.0.0+b')!)).toBe(0);
    expect(compareSemVer(parseSemVer('1.0.0-rc.1')!, parseSemVer('1.0.0-rc.1')!)).toBe(0);
  });
});

describe('tagMatcher', () => {
  it('treats * as a wildcard and everything else literally', () => {
    const matches = tagMatcher('v*.*');
    expect(matches('v1.2')).toBe(true);
    expect(matches('v1-2')).toBe(false);
    expect(tagMatcher('(a)+[b]')('(a)+[b]')).toBe(true);
    expect(tagMatcher('*')('anything')).toBe(true);
    expect(tagMatcher('v1')('v12')).toBe(false);
  });
});

describe('newestTag', () => {
  const tags = ['v1.0.0', 'v1.10.0', 'v1.9.0', 'v2.0.0-rc.1', 'nightly', 'app-3.0.0'];

  it('picks the highest stable version matching the pattern', () => {
    expect(newestTag(tags, { pattern: 'v*' })).toBe('v1.10.0');
    expect(newestTag(tags)).toBe('app-3.0.0');
  });

  it('includes prereleases when asked', () => {
    expect(newestTag(tags, { pattern: 'v*', prerelease: true })).toBe('v2.0.0-rc.1');
  });

  it('returns undefined without a match', () => {
    expect(newestTag(tags, { pattern: 'release-*' })).toBeUndefined();
    expect(newestTag([])).toBeUndefined();
  });
});
