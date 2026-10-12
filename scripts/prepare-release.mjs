// Prepares the next release from the commits on main since the last version tag: picks the version, updates
// package.json, package-lock.json and CHANGELOG.md, and writes the release notes.
//
// RELEASE_BUMP=auto|patch|minor|major (default auto). In auto mode a commit or pull request marked as breaking means
// major, a feature means minor, anything else patch. Commits whose message contains "[skip release]" are ignored.
// Results go to $GITHUB_OUTPUT (release, version, tag) and the notes to $RELEASE_NOTES (default release-notes.md).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const REPOSITORY = 'https://github.com/VectoDE/Self-Updater';
const run = (command, args) =>
  execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const writeJson = (path, value) =>
  writeFileSync(
    path,
    `${JSON.stringify(value, null, 2)}
`
  );

const output = (values) => {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
  }
  console.log(lines.join('\n'));
};

// Labels of the pull request a commit came from; empty for direct pushes or without the GitHub CLI.
const pullRequestLabels = (sha) => {
  try {
    const labels = run('gh', ['api', `repos/VectoDE/Self-Updater/commits/${sha}/pulls`, '--jq', '.[].labels[].name']);
    return labels.split('\n').filter(Boolean);
  } catch {
    console.warn(`No pull request labels for ${sha}; using the commit message only.`);
    return [];
  }
};

const bumpOf = ({ subject, body, labels }) => {
  if (labels.includes('breaking-change') || /BREAKING[ -]CHANGE/.test(body) || /^\w+(\(.*\))?!:/.test(subject)) {
    return 'major';
  }
  if (labels.includes('enhancement') || /^feat(\(.*\))?:/i.test(subject)) {
    return 'minor';
  }
  return 'patch';
};

const RANK = { patch: 0, minor: 1, major: 2 };

const nextVersion = (current, bump) => {
  const [major, minor, patch] = current.split(/[.+-]/).map(Number);
  const prerelease = current.includes('-');
  if (bump === 'major') {
    return `${major + 1}.0.0`;
  }
  if (bump === 'minor') {
    return `${major}.${minor + 1}.0`;
  }
  // A prerelease such as 2.1.0-rc.1 is completed by its patch release, 2.1.0.
  return prerelease ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
};

const lastTag = run('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*']);
const log = run('git', ['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${lastTag}..HEAD`]);
const commits = log
  .split('\x1e')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [sha, subject, body = ''] = entry.split('\x1f');
    return { sha, subject, body };
  })
  .filter(({ subject, body }) => !`${subject}\n${body}`.includes('[skip release]'));

if (commits.length === 0) {
  console.log(`Nothing to release since ${lastTag}.`);
  output({ release: 'false' });
  process.exit(0);
}

const requested = process.env.RELEASE_BUMP ?? 'auto';
if (!['auto', 'patch', 'minor', 'major'].includes(requested)) {
  throw new Error(`RELEASE_BUMP must be auto, patch, minor or major, not "${requested}".`);
}
const bump =
  requested === 'auto'
    ? commits
        .map((commit) => bumpOf({ ...commit, labels: pullRequestLabels(commit.sha) }))
        .reduce((highest, current) => (RANK[current] > RANK[highest] ? current : highest), 'patch')
    : requested;

const manifest = readJson('package.json');
const current = manifest.version;
const version = nextVersion(current, bump);
writeJson('package.json', { ...manifest, version });
const lock = readJson('package-lock.json');
lock.version = version;
lock.packages[''].version = version;
writeJson('package-lock.json', lock);

// The Unreleased section becomes the release; without hand-written notes the commit subjects are listed.
const changelog = readFileSync('CHANGELOG.md', 'utf8');
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[)/.exec(changelog);
if (!unreleased) {
  throw new Error('CHANGELOG.md has no "## [Unreleased]" section followed by a release.');
}
const written = unreleased[1].trim();
const subjects = commits.map(({ subject }) => '- ' + subject).join('\n');
const notes = written || `### Changed\n\n${subjects}`;
const date = new Date().toISOString().slice(0, 10);
const updated = changelog
  .replace(unreleased[0], `## [Unreleased]\n\n## [${version}] - ${date}\n\n${notes}\n`)
  .replace(
    /\[Unreleased\]: .*\n/,
    `[Unreleased]: ${REPOSITORY}/compare/v${version}...HEAD\n[${version}]: ${REPOSITORY}/compare/${lastTag}...v${version}\n`
  );
writeFileSync('CHANGELOG.md', updated);
writeFileSync(process.env.RELEASE_NOTES ?? 'release-notes.md', `${notes}\n`);

console.log(`${current} -> ${version} (${bump}, ${commits.length} commits since ${lastTag})`);
output({ release: 'true', version, tag: `v${version}` });
