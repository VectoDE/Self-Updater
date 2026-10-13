// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { isSelfUpdaterError } from '../src/errors.js';
import { Git } from '../src/git.js';
import { branchApiRequest, type FetchLike, TargetResolver } from '../src/target.js';
import { makeConfig, recordingLogger, Remote, startServer, tempDir } from './helpers.js';

const SHA = 'a'.repeat(40);

describe('branchApiRequest', () => {
  it('asks GitHub for the bare commit id', () => {
    const request = branchApiRequest(
      makeConfig({
        repo: { url: 'https://github.com/acme/app.git', branch: 'release/1', token: 't' },
        workspace: { path: '/x' },
      })
    );
    expect(request?.url).toBe('https://api.github.com/repos/acme/app/commits/release%2F1');
    expect(request?.headers).toMatchObject({ Accept: 'application/vnd.github.sha', Authorization: 'Bearer t' });
  });

  it('uses GitHub Enterprise and GitLab endpoints', () => {
    const enterprise = branchApiRequest(
      makeConfig({ repo: { url: 'https://git.corp/acme/app.git', provider: 'github' }, workspace: { path: '/x' } })
    );
    expect(enterprise?.url).toBe('https://git.corp/api/v3/repos/acme/app/commits/main');
    expect(enterprise?.headers.Authorization).toBeUndefined();
    const gitlab = branchApiRequest(
      makeConfig({ repo: { url: 'git@gitlab.com:group/sub/app.git', token: 't' }, workspace: { path: '/x' } })
    );
    expect(gitlab?.url).toBe('https://gitlab.com/api/v4/projects/group%2Fsub%2Fapp/repository/branches/main');
    expect(gitlab?.headers['PRIVATE-TOKEN']).toBe('t');
    const custom = branchApiRequest(
      makeConfig({
        repo: { url: 'https://code.example.com/a/b', provider: 'gitlab', apiUrl: 'https://api.example.com/v4/' },
        workspace: { path: '/x' },
      })
    );
    expect(custom?.url).toBe('https://api.example.com/v4/projects/a%2Fb/repository/branches/main');
  });

  it('falls back to git for other hosts and local paths', () => {
    expect(
      branchApiRequest(makeConfig({ repo: { url: 'https://git.example.com/a/b' }, workspace: { path: '/x' } }))
    ).toBeUndefined();
    expect(
      branchApiRequest(makeConfig({ repo: { url: '/srv/repo', provider: 'github' }, workspace: { path: '/x' } }))
    ).toBeUndefined();
  });
});

describe('TargetResolver', () => {
  const resolverFor = (url: string, fetch: FetchLike, extra: Parameters<typeof makeConfig>[0]['repo'] = { url }) => {
    const config = makeConfig({ repo: { ...extra, url }, workspace: { path: tempDir() } });
    const { logger, records } = recordingLogger();
    return {
      resolver: new TargetResolver(config, new Git(config.workspace.path, config.repo), { fetch, logger }),
      records,
    };
  };

  it('uses the GitHub API with a conditional request on the next poll', async () => {
    const calls: RequestInit[] = [];
    const answers = [
      new Response(`${SHA}\n`, { status: 200, headers: { etag: '"v1"' } }),
      new Response(null, { status: 304 }),
    ];
    const { resolver } = resolverFor('https://github.com/acme/app.git', (_url, init) => {
      calls.push(init ?? {});
      return Promise.resolve(answers.shift()!);
    });
    expect(await resolver.resolve()).toEqual({ kind: 'branch', ref: 'main', commit: SHA });
    expect(await resolver.resolve()).toEqual({ kind: 'branch', ref: 'main', commit: SHA });
    expect((calls[1]?.headers as Record<string, string>)['If-None-Match']).toBe('"v1"');
  });

  it('reads the GitLab answer', async () => {
    const { resolver } = resolverFor('https://gitlab.com/acme/app.git', () =>
      Promise.resolve(Response.json({ commit: { id: SHA.toUpperCase() } }))
    );
    expect((await resolver.resolve()).commit).toBe(SHA);
  });

  it('asks git when there is no API for the URL', async () => {
    const remote = new Remote();
    const { resolver, records } = resolverFor(remote.url, () => Promise.reject(new Error('not called')), {
      url: remote.url,
      provider: 'github',
    });
    expect((await resolver.resolve()).commit).toBe(remote.head());
    expect(records).toHaveLength(0);
  });

  it('falls back to git when the API fails or answers nonsense', async () => {
    // The same local server plays API and git host; it rejects both, so the git error proves the fallback ran.
    const server = await startServer((_, response) => response.writeHead(500).end());
    const answers = [
      new Response('rate limited', { status: 403 }),
      Response.json({ commit: {} }),
      new Response('nope'),
    ];
    for (const answer of answers) {
      const { resolver, records } = resolverFor(`${server.url}/acme/app.git`, () => Promise.resolve(answer), {
        url: '',
        provider: answer.headers.get('content-type')?.includes('json') ? 'gitlab' : 'github',
        apiUrl: server.url,
      });
      await expect(resolver.resolve()).rejects.toThrow(/git ls-remote failed/);
      expect(records[0]?.message).toBe('Provider API unavailable, asking git instead');
      expect(String(records[0]?.fields.error)).toMatch(/answered 403|did not return a commit id/);
    }
  });

  it('reports a missing branch', async () => {
    const remote = new Remote();
    const config = makeConfig({ repo: { url: remote.url, branch: 'nope' }, workspace: { path: tempDir() } });
    const resolver = new TargetResolver(config, new Git(config.workspace.path, config.repo));
    await expect(resolver.resolve()).rejects.toSatisfy((error) => isSelfUpdaterError(error, 'TARGET_NOT_FOUND'));
  });

  it('picks the newest matching tag in tag mode', async () => {
    const remote = new Remote();
    remote.tag('v1.0.0');
    const newest = remote.commit({ a: '1' });
    remote.annotatedTag('v1.2.0');
    remote.commit({ b: '1' });
    remote.tag('v2.0.0-rc.1');
    remote.tag('other-9.0.0');
    const config = makeConfig({ repo: { url: remote.url }, track: { mode: 'tag' }, workspace: { path: tempDir() } });
    const resolver = new TargetResolver(config, new Git(config.workspace.path, config.repo));
    expect(await resolver.resolve()).toEqual({ kind: 'tag', ref: 'v1.2.0', commit: newest });

    const none = makeConfig({
      repo: { url: remote.url },
      track: { mode: 'tag', tagPattern: 'release-*' },
      workspace: { path: tempDir() },
    });
    await expect(new TargetResolver(none, new Git(none.workspace.path, none.repo)).resolve()).rejects.toThrow(
      /No tag matching "release-\*"/
    );
  });
});
