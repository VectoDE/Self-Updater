// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import type { UpdaterConfig } from './config/schema.js';
import { messageOf, SelfUpdaterError } from './errors.js';
import { detectProvider, type Git, hostOf, projectPathOf } from './git.js';
import { type Logger, silentLogger } from './logger.js';
import { newestTag } from './semver.js';

/** What should be deployed: a branch head or a release tag, and its commit. */
export interface Target {
  kind: 'branch' | 'tag';
  /** Branch or tag name. */
  ref: string;
  commit: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const SHA = /^[\da-f]{40}(?:[\da-f]{24})?$/;

/** The API endpoint that answers with the head commit of the branch, or undefined for plain git. */
export const branchApiRequest = (
  config: UpdaterConfig
): { url: string; headers: Record<string, string>; read: (response: Response) => Promise<string> } | undefined => {
  const { repo } = config;
  const provider = detectProvider(repo);
  const project = projectPathOf(repo.url);
  const host = hostOf(repo.url);
  if (provider === 'git' || !project || !host) {
    return undefined;
  }
  const branch = encodeURIComponent(repo.branch);
  if (provider === 'github') {
    const base = repo.apiUrl ?? (host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`);
    return {
      url: `${base}/repos/${project}/commits/${branch}`,
      // The "sha" media type answers with the bare commit id: a few bytes instead of the whole commit.
      headers: {
        Accept: 'application/vnd.github.sha',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(repo.token ? { Authorization: `Bearer ${repo.token}` } : {}),
      },
      read: async (response) => (await response.text()).trim(),
    };
  }
  const base = repo.apiUrl ?? `https://${host}/api/v4`;
  return {
    url: `${base}/projects/${encodeURIComponent(project)}/repository/branches/${branch}`,
    headers: { Accept: 'application/json', ...(repo.token ? { 'PRIVATE-TOKEN': repo.token } : {}) },
    read: async (response) => {
      const body = (await response.json()) as { commit?: { id?: unknown } };
      return typeof body.commit?.id === 'string' ? body.commit.id : '';
    },
  };
};

/**
 * Finds the commit to deploy. Remembers the last API answer, so polling an unchanged branch costs a conditional
 * request (HTTP 304, which GitHub does not count against the rate limit).
 */
export class TargetResolver {
  private etag: string | undefined;
  private cached: string | undefined;

  constructor(
    private readonly config: UpdaterConfig,
    private readonly git: Git,
    private readonly options: { fetch?: FetchLike; logger?: Logger } = {}
  ) {}

  private get logger() {
    return this.options.logger ?? silentLogger;
  }

  async resolve(): Promise<Target> {
    return this.config.track.mode === 'tag' ? this.resolveTag() : this.resolveBranch();
  }

  private async resolveTag(): Promise<Target> {
    const { tagPattern, prerelease } = this.config.track;
    const tags = await this.git.listRemote('tags');
    const tag = newestTag(
      tags.map(({ name }) => name),
      { pattern: tagPattern, prerelease }
    );
    const match = tags.find(({ name }) => name === tag);
    if (!tag || !match) {
      throw new SelfUpdaterError('TARGET_NOT_FOUND', `No tag matching "${tagPattern}" with a version number.`);
    }
    return { kind: 'tag', ref: tag, commit: match.commit };
  }

  private async resolveBranch(): Promise<Target> {
    const { branch } = this.config.repo;
    const request = branchApiRequest(this.config);
    if (request) {
      try {
        const commit = await this.fromApi(request);
        return { kind: 'branch', ref: branch, commit };
      } catch (error) {
        this.logger.warn('Provider API unavailable, asking git instead', { error: messageOf(error) });
      }
    }
    const heads = await this.git.listRemote('heads', `refs/heads/${branch}`);
    const head = heads.find(({ name }) => name === branch);
    if (!head) {
      throw new SelfUpdaterError('TARGET_NOT_FOUND', `Branch "${branch}" does not exist on the remote.`);
    }
    return { kind: 'branch', ref: branch, commit: head.commit };
  }

  private async fromApi(request: NonNullable<ReturnType<typeof branchApiRequest>>): Promise<string> {
    const fetchImpl = this.options.fetch ?? fetch;
    const headers = { 'User-Agent': 'self-updater', ...request.headers };
    const response = await fetchImpl(request.url, {
      headers: this.etag && this.cached ? { ...headers, 'If-None-Match': this.etag } : headers,
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    if (response.status === 304 && this.cached) {
      return this.cached;
    }
    if (!response.ok) {
      throw new Error(`${request.url} answered ${response.status}`);
    }
    const commit = (await request.read(response)).toLowerCase();
    if (!SHA.test(commit)) {
      throw new Error(`${request.url} did not return a commit id`);
    }
    this.etag = response.headers.get('etag') ?? undefined;
    this.cached = commit;
    return commit;
  }
}
