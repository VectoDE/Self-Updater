import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RepoConfig } from '../src/config/schema.js';
import { isSelfUpdaterError } from '../src/errors.js';
import { detectProvider, Git, gitEnvironment, hostOf, projectPathOf } from '../src/git.js';
import { git, Remote, slash, startServer, tempDir } from './helpers.js';

const repo = (url: string, fields: Partial<RepoConfig> = {}): RepoConfig => ({
  url,
  branch: 'main',
  remote: 'origin',
  provider: 'auto',
  ...fields,
});

describe('URL helpers', () => {
  it('finds host and project in every URL form', () => {
    expect(hostOf('https://GitHub.com/acme/app.git')).toBe('github.com');
    expect(hostOf('git@gitlab.example.com:group/sub/app.git')).toBe('gitlab.example.com');
    expect(hostOf('/srv/repo')).toBeUndefined();
    expect(projectPathOf('https://github.com/acme/app.git/')).toBe('acme/app');
    expect(projectPathOf('git@gitlab.com:group/sub/app.git')).toBe('group/sub/app');
    expect(projectPathOf('ssh://git@host:22//acme/app')).toBe('acme/app');
    expect(projectPathOf('https://example.com/app')).toBeUndefined();
    expect(projectPathOf('not a url')).toBeUndefined();
  });

  it('detects the provider unless it is set', () => {
    expect(detectProvider(repo('https://github.com/a/b'))).toBe('github');
    expect(detectProvider(repo('https://gitlab.example.com/a/b'))).toBe('gitlab');
    expect(detectProvider(repo('https://git.example.com/a/b'))).toBe('git');
    expect(detectProvider(repo('https://git.example.com/a/b', { provider: 'gitlab' }))).toBe('gitlab');
  });
});

describe('gitEnvironment', () => {
  const header = (env: NodeJS.ProcessEnv) =>
    Buffer.from(String(env.GIT_CONFIG_VALUE_0).split(' ')[2] ?? '', 'base64').toString();

  it('passes the token as a header scoped to the repository origin', () => {
    const env = gitEnvironment(repo('https://github.com/a/b.git', { token: 'tok' }), {});
    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
      GIT_CONFIG_KEY_1: 'credential.helper',
      GIT_CONFIG_VALUE_1: '',
    });
    expect(header(env)).toBe('x-access-token:tok');
    expect(header(gitEnvironment(repo('https://gitlab.com/a/b.git', { token: 'tok' }), {}))).toBe('oauth2:tok');
  });

  it('adds nothing for SSH, local paths or without a token', () => {
    for (const config of [
      repo('git@github.com:a/b.git', { token: 't' }),
      repo('/srv/repo', { token: 't' }),
      repo('https://github.com/a/b'),
    ]) {
      expect(gitEnvironment(config, {}).GIT_CONFIG_COUNT).toBe('0');
    }
  });

  it('really sends the header to the server', async () => {
    const server = await startServer((_, response) => response.writeHead(401).end());
    const workspace = tempDir();
    const client = new Git(workspace, repo(`${server.url}/acme/app.git`, { token: 'sekret' }));
    await expect(client.listRemote('heads')).rejects.toThrow();
    const sent = server.requests[0]?.headers.authorization;
    expect(sent).toBe(`Basic ${Buffer.from('x-access-token:sekret').toString('base64')}`);
  });
});

describe('Git', () => {
  it('creates a checkout, fetches, checks out and compares commits', async () => {
    const remote = new Remote();
    const first = remote.head();
    const second = remote.commit({ 'package.json': '{}', 'src/a.js': '1' });
    const dir = path.join(tempDir(), 'app');
    const client = new Git(dir, repo(remote.url));
    expect(client.isRepository()).toBe(false);
    expect(await client.prepare()).toBe('created');
    expect(await client.head()).toBeUndefined();
    expect(await client.fetch({ branch: 'main' }, false)).toBe(second);
    await client.checkout(second);
    expect(await client.head()).toBe(second);
    expect(await client.hasCommit(first)).toBe(true);
    expect(await client.hasCommit('0'.repeat(40))).toBe(false);
    expect((await client.changedFiles(first, second)).sort((a, b) => a.localeCompare(b))).toEqual([
      'package.json',
      'src/a.js',
    ]);
    expect(await client.prepare()).toBe('existing');
  });

  it('fixes the remote of an existing checkout', async () => {
    const remote = new Remote();
    const dir = tempDir();
    git(dir, 'init', '--quiet');
    const client = new Git(dir, repo(remote.url));
    await client.prepare();
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(remote.url);
    git(dir, 'remote', 'set-url', 'origin', '/somewhere/else');
    await client.prepare();
    expect(git(dir, 'remote', 'get-url', 'origin')).toBe(remote.url);
  });

  it('refuses a non-empty directory that is not a checkout', async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'file.txt'), 'x');
    await expect(new Git(dir, repo('/x')).prepare()).rejects.toSatisfy((error) =>
      isSelfUpdaterError(error, 'WORKSPACE_NOT_EMPTY')
    );
  });

  it('lists remote branches and tags, resolving annotated tags to commits', async () => {
    const remote = new Remote();
    const first = remote.head();
    remote.tag('v1.0.0');
    const second = remote.commit({ a: '1' });
    remote.annotatedTag('v1.1.0');
    git(remote.dir, 'branch', 'develop');
    const client = new Git(tempDir(), repo(remote.url));
    expect(await client.listRemote('tags')).toEqual(
      expect.arrayContaining([
        { name: 'v1.0.0', commit: first },
        { name: 'v1.1.0', commit: second },
      ])
    );
    expect(await client.listRemote('heads', 'refs/heads/develop')).toEqual([{ name: 'develop', commit: second }]);
    const fetched = await client.prepare().then(() => client.fetch({ tag: 'v1.1.0' }, true));
    expect(fetched).toBe(second);
  });

  it('reports git failures with the error output', async () => {
    const client = new Git(tempDir(), repo(path.join(tempDir(), 'missing')));
    await client.prepare();
    await expect(client.fetch({ branch: 'main' }, false)).rejects.toSatisfy(
      (error) => isSelfUpdaterError(error, 'GIT_FAILED') && error.message.startsWith('git fetch failed')
    );
  });

  it('verifies SSH signatures against an allowed signers file', async () => {
    const keys = tempDir();
    const key = path.join(keys, 'id_ed25519');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release', '-f', key]);
    const publicKey = execFileSync('ssh-keygen', ['-y', '-f', key], { encoding: 'utf8' }).trim();
    const signers = path.join(keys, 'allowed_signers');
    writeFileSync(signers, `test@example.com ${publicKey}\n`);

    const remote = new Remote();
    const signing = ['-c', 'gpg.format=ssh', '-c', `user.signingkey=${slash(key)}`];
    git(remote.dir, ...signing, 'commit', '--quiet', '--allow-empty', '-S', '-m', 'signed');
    const signed = remote.head();
    git(remote.dir, ...signing, 'tag', '-s', 'v2.0.0', '-m', 'v2.0.0');
    const unsigned = remote.commit({ b: '1' }, 'unsigned');
    remote.annotatedTag('v2.0.1');

    const dir = tempDir();
    const client = new Git(dir, repo(remote.url), { allowedSigners: signers });
    await client.prepare();
    await client.fetch({ branch: 'main' }, false);
    await client.fetch({ tag: 'v2.0.0' }, false);
    await client.fetch({ tag: 'v2.0.1' }, false);
    await expect(client.verify({ commit: signed })).resolves.toBeUndefined();
    await expect(client.verify({ tag: 'v2.0.0' })).resolves.toBeUndefined();
    await expect(client.verify({ commit: unsigned })).rejects.toSatisfy(
      (error) => isSelfUpdaterError(error, 'SIGNATURE_INVALID') && error.message.startsWith('Commit ')
    );
    await expect(client.verify({ tag: 'v2.0.1' })).rejects.toThrow(/^Tag v2.0.1 has no valid signature/);

    // Without the allowed signers file git cannot trust the key.
    await expect(new Git(dir, repo(remote.url)).verify({ commit: signed })).rejects.toThrow(/no valid signature/);
  });
});
