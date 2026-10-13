// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { type ProviderType, type RepoConfig, trimTrailingSlashes } from './config/schema.js';
import { SelfUpdaterError } from './errors.js';
import { run } from './exec.js';

export interface RemoteRef {
  name: string;
  commit: string;
}

/** github, gitlab or plain git, from the configured provider or the host name of the URL. */
export const detectProvider = (repo: Pick<RepoConfig, 'url' | 'provider'>): Exclude<ProviderType, 'auto'> => {
  if (repo.provider !== 'auto') {
    return repo.provider;
  }
  const host = hostOf(repo.url);
  if (host === 'github.com') {
    return 'github';
  }
  if (host?.includes('gitlab')) {
    return 'gitlab';
  }
  return 'git';
};

/** Host name of an HTTPS, SSH or scp-like URL. */
export const hostOf = (url: string): string | undefined => {
  const scp = /^[\w.-]+@([\w.-]+):/.exec(url);
  if (scp) {
    return scp[1]?.toLowerCase();
  }
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/** "owner/repo" (or "group/subgroup/repo") from any URL form, without .git. */
export const projectPathOf = (url: string): string | undefined => {
  const scp = /^[\w.-]+@[\w.-]+:(.+)$/.exec(url);
  let pathname: string;
  if (scp?.[1]) {
    pathname = scp[1];
  } else {
    try {
      pathname = new URL(url).pathname;
    } catch {
      return undefined;
    }
  }
  let trimmed = trimTrailingSlashes(pathname);
  if (trimmed.endsWith('.git')) {
    trimmed = trimmed.slice(0, -'.git'.length);
  }
  while (trimmed.startsWith('/')) {
    trimmed = trimmed.slice(1);
  }
  return trimmed.includes('/') ? trimmed : undefined;
};

/**
 * Git configuration passed through the environment (GIT_CONFIG_COUNT), so the token never shows up in a URL, in
 * .git/config or in the process list. The header is scoped to the repository's origin and goes nowhere else.
 */
export const gitEnvironment = (
  repo: Pick<RepoConfig, 'url' | 'token' | 'provider'>,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv => {
  // A daemon must never wait for a password prompt or a credential manager window.
  const env: NodeJS.ProcessEnv = {
    ...base,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: 'never',
  };
  const settings: [string, string][] = [];
  if (repo.token) {
    let origin: string | undefined;
    try {
      const url = new URL(repo.url);
      origin = url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : undefined;
    } catch {
      origin = undefined;
    }
    if (origin) {
      const user = detectProvider(repo) === 'gitlab' ? 'oauth2' : 'x-access-token';
      const credentials = Buffer.from(`${user}:${repo.token}`).toString('base64');
      settings.push(
        [`http.${origin}/.extraHeader`, `Authorization: Basic ${credentials}`],
        // The token is the only credential: an empty value clears configured helpers, which could prompt for a
        // password or answer with another account.
        ['credential.helper', '']
      );
    }
  }
  env.GIT_CONFIG_COUNT = String(settings.length);
  settings.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
};

export interface GitOptions {
  /** Configuration for a single call, e.g. gpg.ssh.allowedSignersFile. */
  allowedSigners?: string;
  timeoutSeconds?: number;
}

/** The handful of git commands the updater needs, run without a shell. */
export class Git {
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    readonly dir: string,
    private readonly repo: RepoConfig,
    private readonly options: GitOptions = {}
  ) {
    this.env = gitEnvironment(repo);
  }

  private async git(args: string[], options: { cwd?: string; allowFailure?: boolean } = {}): Promise<string> {
    const result = await run(['git', ...args], {
      cwd: options.cwd ?? this.dir,
      env: this.env,
      timeoutSeconds: this.options.timeoutSeconds ?? 600,
    });
    if (result.code !== 0 && !options.allowFailure) {
      const output = (result.stderr || result.stdout).trim().split('\n').slice(-10).join('\n');
      throw new SelfUpdaterError('GIT_FAILED', `git ${args[0] ?? ''} failed (${result.code}): ${output}`);
    }
    return result.code === 0 ? result.stdout.trim() : '';
  }

  /** True when the directory holds a git checkout. */
  isRepository(): boolean {
    return existsSync(path.join(this.dir, '.git'));
  }

  /**
   * Makes sure the workspace is a checkout of the configured repository: creates it when the directory is missing or
   * empty, and points the remote at the configured URL. Refuses a non-empty directory that is not a checkout.
   */
  async prepare(): Promise<'created' | 'existing'> {
    if (this.isRepository()) {
      const current = await this.git(['remote', 'get-url', this.repo.remote], { allowFailure: true });
      if (!current) {
        await this.git(['remote', 'add', this.repo.remote, this.repo.url]);
      } else if (current !== this.repo.url) {
        await this.git(['remote', 'set-url', this.repo.remote, this.repo.url]);
      }
      return 'existing';
    }
    if (existsSync(this.dir) && readdirSync(this.dir).length > 0) {
      throw new SelfUpdaterError(
        'WORKSPACE_NOT_EMPTY',
        `${this.dir} is not empty and not a git checkout. Point workspace.path at an empty directory or a checkout.`
      );
    }
    await mkdir(this.dir, { recursive: true });
    await this.git(['init', '--quiet']);
    await this.git(['remote', 'add', this.repo.remote, this.repo.url]);
    return 'created';
  }

  /** The checked-out commit, or undefined in a fresh repository. */
  async head(): Promise<string | undefined> {
    const sha = await this.git(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFailure: true });
    return sha || undefined;
  }

  /** Whether the commit is in the local object database. */
  async hasCommit(sha: string): Promise<boolean> {
    const result = await run(['git', 'cat-file', '-e', `${sha}^{commit}`], { cwd: this.dir, env: this.env });
    return result.code === 0;
  }

  /** Fetches a branch or tag and returns the commit it points to. */
  async fetch(ref: { branch: string } | { tag: string }, shallow: boolean): Promise<string> {
    const refspec =
      'branch' in ref
        ? `+refs/heads/${ref.branch}:refs/remotes/${this.repo.remote}/${ref.branch}`
        : `+refs/tags/${ref.tag}:refs/tags/${ref.tag}`;
    await this.git(['fetch', '--quiet', '--no-tags', ...(shallow ? ['--depth', '1'] : []), this.repo.remote, refspec]);
    const local = 'branch' in ref ? `refs/remotes/${this.repo.remote}/${ref.branch}` : `refs/tags/${ref.tag}`;
    return this.git(['rev-parse', '--verify', `${local}^{commit}`]);
  }

  /** Points the local branch at the commit and makes the working tree match it, discarding local edits. */
  async checkout(sha: string): Promise<void> {
    await this.git(['checkout', '--quiet', '--force', '-B', this.repo.branch, sha]);
  }

  /** Paths that differ between two commits. */
  async changedFiles(from: string, to: string): Promise<string[]> {
    const output = await this.git(['diff', '--name-only', '--no-renames', from, to]);
    return output.split('\n').filter(Boolean);
  }

  /** Branch heads or tags of the remote, without fetching anything. Annotated tags resolve to their commit. */
  async listRemote(kind: 'heads' | 'tags', pattern?: string): Promise<RemoteRef[]> {
    const output = await this.git(['ls-remote', `--${kind}`, this.repo.url, ...(pattern ? [pattern] : [])], {
      cwd: existsSync(this.dir) ? this.dir : process.cwd(),
    });
    const refs = new Map<string, string>();
    for (const line of output.split('\n')) {
      const [sha, name] = line.trim().split('\t');
      if (!sha || !name) {
        continue;
      }
      const short = name.replace(/^refs\/(heads|tags)\//, '');
      // "v1.0.0^{}" is the commit an annotated tag points to; it wins over the tag object itself.
      if (short.endsWith('^{}')) {
        refs.set(short.slice(0, -3), sha);
      } else if (!refs.has(short)) {
        refs.set(short, sha);
      }
    }
    return [...refs].map(([name, commit]) => ({ name, commit }));
  }

  /** Checks the signature of a commit or an annotated tag with git's own verification. */
  async verify(target: { commit: string } | { tag: string }): Promise<void> {
    const config = this.options.allowedSigners
      ? ['-c', `gpg.ssh.allowedSignersFile=${this.options.allowedSigners}`]
      : [];
    // "--" ends the options: a tag name from the remote must never be read as one.
    const args = 'commit' in target ? ['verify-commit', '--', target.commit] : ['verify-tag', '--', target.tag];
    const result = await run(['git', ...config, ...args], { cwd: this.dir, env: this.env, timeoutSeconds: 60 });
    if (result.code !== 0) {
      const what = 'commit' in target ? `Commit ${target.commit.slice(0, 12)}` : `Tag ${target.tag}`;
      throw new SelfUpdaterError(
        'SIGNATURE_INVALID',
        `${what} has no valid signature: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' ')}`
      );
    }
  }
}
