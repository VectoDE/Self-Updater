import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildInitConfig, type CliIo, parseEnvLine, runCli } from '../src/cli/run.js';
import { parseConfig } from '../src/config/schema.js';
import { Remote, slash, tempDir } from './helpers.js';

const cli = async (args: string[], extra: Partial<CliIo> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(args, {
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    env: {},
    ...extra,
  });
  // Log lines come first; the result of the command is the last line.
  return { code, out: out.join('\n'), last: out.at(-1) ?? '', err: err.join('\n') };
};

/** A repository, a configuration for it and a path to that configuration. */
const project = (fields: Record<string, unknown> = {}) => {
  const remote = new Remote();
  const dir = tempDir();
  const file = path.join(dir, 'updater.config.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 3,
      repo: { url: slash(remote.url) },
      workspace: { path: './app' },
      service: { type: 'none' },
      ...fields,
    })
  );
  return { remote, dir, file };
};

describe('runCli basics', () => {
  it('prints version and help', async () => {
    expect(await cli(['--version'])).toMatchObject({ code: 0, out: expect.stringMatching(/^\d+\.\d+\.\d+/) });
    expect((await cli(['--help'])).out).toContain('Usage: self-updater <command>');
    expect((await cli(['init', '--help'])).out).toContain('--repo <url>');
    expect(await cli([])).toMatchObject({ code: 2, out: expect.stringContaining('Commands') });
  });

  it('rejects unknown commands, options and missing values', async () => {
    expect(await cli(['deploy'])).toMatchObject({ code: 2, err: expect.stringContaining('Unknown command "deploy"') });
    expect((await cli(['update', '--nope'])).code).toBe(2);
    expect((await cli(['update', '--config'])).code).toBe(2);
    const json = await cli(['deploy', '--json']);
    expect(JSON.parse(json.err)).toEqual({ error: { code: 'USAGE', message: expect.any(String) } });
  });

  it('reports a missing or broken configuration as a configuration error', async () => {
    const dir = tempDir();
    const missing = await cli(['validate', '-c', path.join(dir, 'none.json')]);
    expect(missing.code).toBe(2);
    const broken = path.join(dir, 'broken.json');
    writeFileSync(broken, '{');
    expect((await cli(['validate', '-c', broken])).err).toMatch(/not valid JSON/);
    writeFileSync(broken, '{"version":3,"repo":{"url":""}}');
    const invalid = await cli(['validate', '--config', broken, '--json']);
    expect(invalid.code).toBe(2);
    expect((JSON.parse(invalid.err) as { error: { code: string } }).error.code).toBe('CONFIG_INVALID');
  });
});

describe('init', () => {
  it('writes a valid configuration with placeholders for secrets', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'updater.config.json');
    const args = [
      'init',
      '-c',
      file,
      '--repo',
      'https://github.com/acme/app.git',
      '--path',
      '/srv/app',
      '--type',
      'pm2',
      '--name',
      'app',
      '--token-env',
      'GITHUB_TOKEN',
      '--install',
      '--health-url',
      'http://127.0.0.1:3000/health',
      '--webhook-port',
      '9000',
      '--interval',
      '120',
    ];
    const result = await cli(args);
    expect(result).toMatchObject({ code: 0, out: `Configuration written to ${file}` });
    const written = JSON.parse(readFileSync(file, 'utf8'));
    expect(written).toMatchObject({
      repo: { token: '${GITHUB_TOKEN}' },
      webhook: { enabled: true, port: 9000, secret: '${SELF_UPDATER_WEBHOOK_SECRET}' },
      schedule: { intervalSeconds: 120 },
      healthCheck: { url: 'http://127.0.0.1:3000/health' },
    });
    expect((await cli(args)).code).toBe(2);
    expect((await cli([...args, '--force', '--json'])).code).toBe(0);
  });

  it('explains what is missing or wrong', async () => {
    const file = path.join(tempDir(), 'c.json');
    expect((await cli(['init', '-c', file, '--repo', 'x'])).err).toMatch(/init needs --path, --type/);
    const base = ['init', '-c', file, '--repo', 'https://github.com/a/b', '--path', '/srv/app', '--type'];
    expect((await cli([...base, 'pm2', '--token-env', 'not valid'])).err).toMatch(/--token-env/);
    expect((await cli([...base, 'pm2', '--interval', 'soon'])).err).toMatch(/--interval must be a whole number/);
    expect((await cli([...base, 'compose'])).err).toMatch(/would be invalid/);
    expect(existsSync(file)).toBe(false);
  });

  it('builds tag mode, hooks and service options', () => {
    const input = buildInitConfig({
      repo: 'git@github.com:acme/app.git',
      path: '/srv/app',
      type: 'compose',
      'compose-file': 'prod.yml',
      'compose-service': 'web',
      sudo: true,
      'tag-pattern': 'v*',
      prerelease: true,
      'require-signature': true,
      pre: 'npm test',
      post: 'echo done',
      'health-command': 'curl -f localhost',
      'no-rollback': true,
      jitter: '5',
    });
    expect(input).toMatchObject({
      track: { mode: 'tag', tagPattern: 'v*', prerelease: true, requireSignature: true },
      service: { type: 'compose', composeFile: 'prod.yml', composeService: 'web', sudo: true },
      hooks: { preUpdate: 'npm test', postUpdate: 'echo done' },
      rollback: { enabled: false },
      schedule: { jitterSeconds: 5 },
    });
    expect(input.webhook).toBeUndefined();
    expect(parseConfig(input).ok).toBe(true);
  });
});

describe('migrate', () => {
  it('converts a 2.x file and keeps a backup', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'updater.config.json');
    const old = {
      version: 2,
      repo: { url: 'https://github.com/acme/app.git', branch: 'main', authToken: '${GITHUB_TOKEN}' },
      workspace: { localPath: '/srv/app', autoInstall: true },
      service: { type: 'pm2', name: 'app' },
      schedule: { intervalSeconds: 60 },
    };
    writeFileSync(file, JSON.stringify(old));
    const before = await cli(['validate', '-c', file], { env: { GITHUB_TOKEN: 'token-value' } });
    expect(before.out).toMatch(/older format/);
    const result = await cli(['migrate', '-c', file]);
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual(old);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ version: 3, rollback: { enabled: false } });
    expect((await cli(['migrate', '-c', file])).out).toMatch(/already uses version 3/);
    expect((await cli(['migrate', '-c', path.join(dir, 'none.json')])).code).toBe(2);
  });
});

describe('commands on a repository', () => {
  it('validates, shows status, updates and reports up to date', async () => {
    const { remote, file } = project();
    expect((await cli(['validate', '-c', file])).out).toMatch(/is valid\.$/);
    const status = await cli(['status', '-c', file]);
    expect(status.out).toMatch(/^Update available\nDeployed: nothing yet\nRemote: {3}\w{40} \(branch main\)$/);
    expect((await cli(['update', '-c', file, '--dry-run'])).last).toMatch(/^Update available: main @/);
    const update = await cli(['run-once', '-c', file]);
    expect(update).toMatchObject({ code: 0 });
    expect(update.out).toMatch(/Deployed main @/);
    const json = await cli(['update', '-c', file, '--json']);
    expect(JSON.parse(json.out.slice(json.out.indexOf('{\n')))).toMatchObject({
      outcome: 'up-to-date',
      commit: remote.head(),
    });
    expect((await cli(['status', '-c', file])).out).toMatch(/^Up to date[\s\S]*Last update: /);
  });

  it('exits with 3 after a rollback and 1 after a failure, and rolls back by hand', async () => {
    const { remote, dir, file } = project({
      healthCheck: { command: "node -e \"process.exit(require('fs').existsSync('broken') ? 1 : 0)\"", retries: 0 },
    });
    const v1 = remote.head();
    expect((await cli(['update', '-c', file])).code).toBe(0);
    remote.commit({ broken: '' });
    const rolledBack = await cli(['update', '-c', file]);
    expect(rolledBack.code).toBe(3);
    expect(rolledBack.out).toMatch(/failed and was rolled back to/);
    expect((await cli(['update', '-c', file])).last).toMatch(/^Skipped main @ \w+: it failed before/);
    expect((await cli(['status', '-c', file])).out).toMatch(/is skipped until a newer one arrives/);

    remote.commit({ broken: '', other: '1' });
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    config.rollback = { enabled: false };
    writeFileSync(file, JSON.stringify(config));
    const failed = await cli(['update', '-c', file]);
    expect(failed.code).toBe(1);
    expect(failed.last).toMatch(/^Deployment of main @ \w+ failed: /);

    const manual = await cli(['rollback', '-c', file, '--to', v1]);
    expect(manual).toMatchObject({ code: 0, last: `Rolled back to ${v1}.` });
    expect(existsSync(path.join(dir, 'updater.state.json'))).toBe(true);
    expect((await cli(['rollback', '-c', file, '--to', 'f'.repeat(40)])).code).toBe(1);
  });

  it('reads variables from .env and logs as JSON with --json', async () => {
    const { dir, file } = project({ repo: { url: '${REPO_PATH}' } });
    const { remote } = project();
    writeFileSync(path.join(dir, '.env'), `# local settings\nexport REPO_PATH="${slash(remote.url)}"\n`);
    const env: NodeJS.ProcessEnv = { SELF_UPDATER_LOG_LEVEL: 'debug' };
    const result = await cli(['update', '-c', file, '--json'], { env });
    expect(result.code).toBe(0);
    expect(env.REPO_PATH).toBe(slash(remote.url));
    expect(result.out.split('\n')[0]).toMatch(/^\{"time":/);
    expect((await cli(['update', '-c', file, '--env-file', path.join(dir, 'missing.env')])).err).toMatch(
      /missing\.env does not exist/
    );
  });

  it('runs the agent until the signal aborts it', async () => {
    const { remote, dir, file } = project();
    const controller = new AbortController();
    const running = cli(['start', '-c', file, '--immediate'], { signal: controller.signal });
    const workspaceHead = path.join(dir, 'app', '.git', 'HEAD');
    await expect
      .poll(
        () =>
          existsSync(workspaceHead) &&
          readFileSync(path.join(dir, 'updater.state.json'), 'utf8').includes(remote.head()),
        {
          timeout: 20_000,
        }
      )
      .toBe(true);
    controller.abort();
    const result = await running;
    expect(result.code).toBe(0);
    expect(result.out).toMatch(/Agent started[\s\S]*Agent stopped/);
    expect((await cli(['start', '-c', file], { signal: AbortSignal.abort() })).code).toBe(0);
  });
});

describe('parseEnvLine', () => {
  it('reads NAME=value lines and skips the rest', () => {
    expect(parseEnvLine('TOKEN=abc')).toEqual(['TOKEN', 'abc']);
    expect(parseEnvLine('  export NAME = "a b" ')).toEqual(['NAME', 'a b']);
    expect(parseEnvLine("QUOTED='x=y'")).toEqual(['QUOTED', 'x=y']);
    expect(parseEnvLine('EMPTY=')).toEqual(['EMPTY', '']);
    expect(parseEnvLine('HALF="open')).toEqual(['HALF', '"open']);
    for (const line of ['', '   ', '# comment', '=value', 'not a line', '1BAD=x']) {
      expect(parseEnvLine(line)).toBeUndefined();
    }
  });
});
