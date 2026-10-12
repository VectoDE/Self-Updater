/**
 * Just enough Semantic Versioning 2.0.0 to pick the newest release tag: parsing with an optional prefix such as "v"
 * or "release-", and precedence as the specification defines it. Build metadata is ignored for ordering.
 */
export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  prerelease: (string | number)[];
}

const NUMBER = /^(?:0|[1-9]\d*)$/;
const IDENTIFIER = /^[\da-z-]+$/i;

const isNumericIdentifier = (part: string) => /^\d+$/.test(part);

/** Parses "1.2.3", "v1.2.3-rc.1" or "release-1.2.3+build.5"; anything before the first digit is a prefix. */
export const parseSemVer = (text: string): SemVer | undefined => {
  const start = text.search(/\d/);
  if (start === -1 || start > 32) {
    return undefined;
  }
  const [versionPart = '', ...build] = text.slice(start).split('+');
  if (build.length > 1 || build.some((part) => part.split('.').some((id) => !IDENTIFIER.test(id)))) {
    return undefined;
  }
  const dash = versionPart.indexOf('-');
  const core = (dash === -1 ? versionPart : versionPart.slice(0, dash)).split('.');
  const pre = dash === -1 ? [] : versionPart.slice(dash + 1).split('.');
  if (core.length !== 3 || core.some((part) => !NUMBER.test(part))) {
    return undefined;
  }
  // Prerelease identifiers are alphanumeric with hyphens; numeric ones must not have leading zeros.
  if (pre.some((part) => !IDENTIFIER.test(part) || (isNumericIdentifier(part) && !NUMBER.test(part)))) {
    return undefined;
  }
  const [major, minor, patch] = core.map(Number) as [number, number, number];
  return {
    major,
    minor,
    patch,
    prerelease: pre.map((part) => (isNumericIdentifier(part) ? Number(part) : part)),
  };
};

const compareIdentifiers = (a: string | number, b: string | number): number => {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.sign(a - b);
  }
  // Numeric identifiers always have lower precedence than alphanumeric ones.
  if (typeof a === 'number') {
    return -1;
  }
  if (typeof b === 'number') {
    return 1;
  }
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

/** Negative when a < b, positive when a > b, 0 when they have the same precedence. */
export const compareSemVer = (a: SemVer, b: SemVer): number => {
  const core = Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
  if (core !== 0) {
    return core;
  }
  // A version without prerelease ranks above any of its prereleases.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return Math.sign(b.prerelease.length - a.prerelease.length);
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined || right === undefined) {
      return left === undefined ? -1 : 1;
    }
    const result = compareIdentifiers(left, right);
    if (result !== 0) {
      return result;
    }
  }
  return 0;
};

/** Turns a tag pattern with "*" wildcards into a matcher; every other character is literal. */
export const tagMatcher = (pattern: string): ((tag: string) => boolean) => {
  const source = pattern
    .split('*')
    .map((part) => part.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`))
    .join('.*');
  const regex = new RegExp(`^${source}$`);
  return (tag) => regex.test(tag);
};

/** The tag with the highest version among those matching the pattern, or undefined. */
export const newestTag = (
  tags: readonly string[],
  options: { pattern?: string; prerelease?: boolean } = {}
): string | undefined => {
  const matches = tagMatcher(options.pattern ?? '*');
  let best: { tag: string; version: SemVer } | undefined;
  for (const tag of tags) {
    const version = matches(tag) ? parseSemVer(tag) : undefined;
    if (!version || (version.prerelease.length > 0 && !options.prerelease)) {
      continue;
    }
    if (!best || compareSemVer(version, best.version) > 0) {
      best = { tag, version };
    }
  }
  return best?.tag;
};
