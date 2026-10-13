// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { UpdaterConfig } from './config/schema.js';
import { messageOf, SelfUpdaterError } from './errors.js';
import { describeCommand, runChecked } from './exec.js';
import { Git, projectPathOf } from './git.js';
import { checkHealth } from './health.js';
import { acquireLock } from './lock.js';
import { type Logger, silentLogger } from './logger.js';
import { createEvent, type DeploymentEvent, notify } from './notify.js';
import { restartCommand } from './service.js';
import { type SlotName, Slots } from './slots.js';
import { type DeploymentRecord, readState, recordDeployment, type UpdaterState, writeState } from './state.js';
import { type FetchLike, type Target, TargetResolver } from './target.js';

export type UpdateOutcome = 'up-to-date' | 'skipped' | 'dry-run' | 'deployed' | 'rolled-back' | 'failed';

export interface UpdateResult {
  outcome: UpdateOutcome;
  target?: Target;
  /** Commit before the update. */
  previousCommit?: string;
  /** Commit checked out after the update (the previous one again after a rollback). */
  commit?: string;
  error?: string;
}

export interface UpdateOptions {
  /** Deploy even when the target is already checked out or failed before. */
  force?: boolean;
  /** Only report what would happen. */
  dryRun?: boolean;
}

export interface StatusReport {
  current?: string;
  target: Target;
  updateAvailable: boolean;
  /** The target failed before and is skipped until something newer arrives. */
  skipped: boolean;
  state: UpdaterState;
}

export interface UpdaterOptions {
  /** Where the state is kept; usually updater.state.json next to the configuration. */
  statePath: string;
  logger?: Logger;
  fetch?: FetchLike;
  /** Replaces the waits of the health check, for tests. */
  wait?: (seconds: number) => Promise<void>;
  platform?: NodeJS.Platform;
}

const EVENT_OF = { deployed: 'success', 'rolled-back': 'rollback', failed: 'failure' } as const;

/** The repository without credentials, for logs and notifications. */
export const repositoryLabel = (url: string): string => {
  const project = projectPathOf(url);
  if (project) {
    return project;
  }
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
};

/** Runs update cycles for one configuration: find the target, deploy it, check it, roll back if needed. */
export class Updater {
  /** The workspace path; with the blue-green strategy, the link to the live checkout. */
  readonly git: Git;
  private readonly resolver: TargetResolver;
  private readonly logger: Logger;
  private readonly gitOptions: { allowedSigners?: string };
  /** Set for the blue-green strategy. */
  private readonly slots: Slots | undefined;

  constructor(
    readonly config: UpdaterConfig,
    private readonly options: UpdaterOptions
  ) {
    this.logger = options.logger ?? silentLogger;
    this.gitOptions = config.track.allowedSigners ? { allowedSigners: config.track.allowedSigners } : {};
    this.git = new Git(config.workspace.path, config.repo, this.gitOptions);
    this.slots =
      config.workspace.strategy === 'blue-green' ? new Slots(config.workspace.path, options.platform) : undefined;
    const resolverOptions: { fetch?: FetchLike; logger: Logger } = { logger: this.logger };
    if (options.fetch) resolverOptions.fetch = options.fetch;
    this.resolver = new TargetResolver(config, this.git, resolverOptions);
  }

  get statePath(): string {
    return this.options.statePath;
  }

  readState(): UpdaterState {
    return readState(this.options.statePath);
  }

  /** The live slot of a blue-green workspace; undefined for in-place workspaces and before the first deployment. */
  activeSlot(): SlotName | undefined {
    return this.slots?.active();
  }

  private gitAt(dir: string): Git {
    return new Git(dir, this.config.repo, this.gitOptions);
  }

  /** The commit that runs now, without changing anything. */
  private async liveCommit(): Promise<string | undefined> {
    if (!this.slots) {
      return this.git.isRepository() ? this.git.head() : undefined;
    }
    const active = this.slots.active();
    return active ? this.gitAt(this.slots.dir(active)).head() : undefined;
  }

  private async lock(): Promise<() => Promise<void>> {
    if (!this.slots) {
      return acquireLock(path.join(this.git.dir, '.git', 'self-updater.lock'));
    }
    await mkdir(path.dirname(this.slots.link), { recursive: true });
    return acquireLock(`${this.slots.link}.lock`);
  }

  /** Compares the checkout with the remote without changing anything. */
  async status(): Promise<StatusReport> {
    const current = await this.liveCommit();
    const target = await this.resolver.resolve();
    const state = this.readState();
    return {
      current,
      target,
      updateAvailable: current !== target.commit,
      skipped: state.failedCommit === target.commit,
      state,
    } as StatusReport;
  }

  /** One update cycle. Never throws for a failed deployment; the result says what happened. */
  async update(options: UpdateOptions = {}): Promise<UpdateResult> {
    if (!this.slots) {
      await this.git.prepare();
    }
    const target = await this.resolver.resolve();
    const previousCommit = await this.liveCommit();
    const state = this.readState();
    const base: UpdateResult = { outcome: 'up-to-date', target, ...(previousCommit ? { previousCommit } : {}) };

    if (previousCommit === target.commit && !options.force) {
      this.logger.debug('Already up to date', { ref: target.ref, commit: target.commit });
      return { ...base, commit: target.commit };
    }
    if (state.failedCommit === target.commit && !options.force) {
      this.logger.warn('Skipping a commit that failed before; push a fix or run with --force', {
        ref: target.ref,
        commit: target.commit,
      });
      return { ...base, outcome: 'skipped', ...(previousCommit ? { commit: previousCommit } : {}) };
    }
    if (options.dryRun) {
      this.logger.info('Update available (dry run, nothing changed)', { ref: target.ref, commit: target.commit });
      return { ...base, outcome: 'dry-run', ...(previousCommit ? { commit: previousCommit } : {}) };
    }

    const release = await this.lock();
    try {
      return this.slots
        ? await this.deployBlueGreen(this.slots, target, previousCommit, state)
        : await this.deploy(target, previousCommit, state);
    } finally {
      await release();
    }
  }

  private async fetchTarget(git: Git, requested: Target): Promise<Target> {
    const fetched = await git.fetch(
      requested.kind === 'tag' ? { tag: requested.ref } : { branch: requested.ref },
      this.config.workspace.shallow
    );
    // The branch may have moved since it was looked up; deploy what was actually fetched.
    return { ...requested, commit: fetched };
  }

  /**
   * Prepares the idle slot while the live one keeps running, then moves the link. Until the link moves, a failure
   * changes nothing that runs; after it, going back is only the link and a restart.
   */
  private async deployBlueGreen(
    slots: Slots,
    requested: Target,
    previousCommit: string | undefined,
    state: UpdaterState
  ): Promise<UpdateResult> {
    const { config, logger } = this;
    const active = slots.active();
    const idle = slots.idle();
    const git = this.gitAt(slots.dir(idle));
    logger.info('Updating', {
      ref: requested.ref,
      from: previousCommit?.slice(0, 12) ?? 'nothing',
      to: requested.commit.slice(0, 12),
      slot: idle,
    });
    await git.prepare();
    const idleBefore = await git.head();
    const target = await this.fetchTarget(git, requested);
    let stage = 'signature check';
    try {
      if (config.track.requireSignature) {
        await git.verify(target.kind === 'tag' ? { tag: target.ref } : { commit: target.commit });
        logger.info('Signature verified', { ref: target.ref });
      }
      stage = 'pre-update hook';
      await this.hook('preUpdate', active ? this.git.dir : git.dir);
      stage = 'checkout';
      await git.checkout(target.commit);
      stage = 'install';
      await this.install(git, idleBefore, target.commit);
    } catch (error) {
      // The live slot was not touched: the old version keeps running.
      return this.finish(state, target, previousCommit, 'failed', previousCommit, `${stage}: ${messageOf(error)}`);
    }

    await slots.switchTo(idle);
    logger.info('Switched to slot', { slot: idle });
    try {
      await this.restartAndCheck();
      await this.hook('postUpdate');
      return await this.finish(state, target, previousCommit, 'deployed', target.commit);
    } catch (error) {
      const reason = messageOf(error);
      logger.error('Deployment failed', { ref: target.ref, commit: target.commit, error: reason });
      if (!config.rollback.enabled || !active || !previousCommit) {
        return this.finish(state, target, previousCommit, 'failed', target.commit, reason);
      }
      logger.warn('Rolling back', { to: previousCommit, slot: active });
      try {
        await slots.switchTo(active);
        await this.restartAndCheck();
        return await this.finish(state, target, previousCommit, 'rolled-back', previousCommit, reason);
      } catch (rollbackError) {
        logger.error('Rollback failed', { error: messageOf(rollbackError) });
        const both = `${reason}; rollback failed too: ${messageOf(rollbackError)}`;
        return this.finish(state, target, previousCommit, 'failed', previousCommit, both);
      }
    }
  }

  private async deploy(
    requested: Target,
    previousCommit: string | undefined,
    state: UpdaterState
  ): Promise<UpdateResult> {
    const { config, logger } = this;
    logger.info('Updating', {
      ref: requested.ref,
      from: previousCommit?.slice(0, 12) ?? 'nothing',
      to: requested.commit.slice(0, 12),
    });
    const target = await this.fetchTarget(this.git, requested);

    let stage = 'signature check';
    try {
      if (config.track.requireSignature) {
        await this.git.verify(target.kind === 'tag' ? { tag: target.ref } : { commit: target.commit });
        logger.info('Signature verified', { ref: target.ref });
      }
      stage = 'pre-update hook';
      await this.hook('preUpdate');
    } catch (error) {
      // Nothing changed yet: the old version keeps running.
      return this.finish(state, target, previousCommit, 'failed', previousCommit, `${stage}: ${messageOf(error)}`);
    }

    await this.git.checkout(target.commit);
    try {
      await this.activate(previousCommit, target.commit, true);
      return await this.finish(state, target, previousCommit, 'deployed', target.commit);
    } catch (error) {
      const reason = messageOf(error);
      logger.error('Deployment failed', { ref: target.ref, commit: target.commit, error: reason });
      if (!config.rollback.enabled || !previousCommit) {
        return this.finish(state, target, previousCommit, 'failed', target.commit, reason);
      }
      return this.rollBack(state, target, previousCommit, reason);
    }
  }

  private async rollBack(
    state: UpdaterState,
    target: Target,
    previousCommit: string,
    reason: string
  ): Promise<UpdateResult> {
    this.logger.warn('Rolling back', { to: previousCommit });
    try {
      await this.git.checkout(previousCommit);
      // The post-update hook belongs to the new version; the old one only has to come back up.
      await this.activate(target.commit, previousCommit, false);
      return await this.finish(state, target, previousCommit, 'rolled-back', previousCommit, reason);
    } catch (error) {
      const both = `${reason}; rollback failed too: ${messageOf(error)}`;
      this.logger.error('Rollback failed', { error: messageOf(error) });
      return this.finish(state, target, previousCommit, 'failed', previousCommit, both);
    }
  }

  /** Install (when needed), restart, health check and, for a new version, the post-update hook. */
  private async activate(from: string | undefined, to: string, withPostHook: boolean): Promise<void> {
    await this.install(this.git, from, to);
    await this.restartAndCheck();
    if (withPostHook) {
      await this.hook('postUpdate');
    }
  }

  private async restartAndCheck(): Promise<void> {
    await this.restart();
    if (this.config.healthCheck) {
      const healthOptions: Parameters<typeof checkHealth>[1] = { cwd: this.git.dir, logger: this.logger };
      if (this.options.fetch) healthOptions.fetch = this.options.fetch;
      if (this.options.wait) healthOptions.wait = this.options.wait;
      await checkHealth(this.config.healthCheck, healthOptions);
    }
  }

  /** Installs in the checkout of git; "changed" compares with what that checkout had before. */
  private async install(git: Git, from: string | undefined, to: string): Promise<void> {
    const { install } = this.config.workspace;
    if (!install.enabled) {
      return;
    }
    if (install.when === 'changed' && from && (await git.hasCommit(from))) {
      const changed = await git.changedFiles(from, to);
      const watched = new Set(install.watch.map((file) => file.replaceAll('\\', '/').replace(/^\.\//, '')));
      if (!changed.some((file) => watched.has(file))) {
        this.logger.debug('Dependencies unchanged, skipping install');
        return;
      }
    }
    this.logger.info('Installing dependencies');
    await this.runLogged(install.command, 'install command', git.dir);
  }

  private async restart(): Promise<void> {
    const command = restartCommand(this.config.service, this.options.platform);
    if (!command) {
      return;
    }
    // Built-in restarts are argument lists made from validated names; a custom command is the operator's text.
    const label = typeof command === 'string' ? 'restart command' : describeCommand(command);
    this.logger.info('Restarting service', { command: label });
    await this.runLogged(command, label);
  }

  private async hook(name: 'preUpdate' | 'postUpdate', cwd = this.git.dir): Promise<void> {
    const command = this.config.hooks[name];
    if (!command) {
      return;
    }
    this.logger.info(`Running ${name} hook`);
    await this.runLogged(command, `${name} hook`, cwd);
  }

  /** Operator commands appear in logs and errors by their label only: their text may hold credentials. */
  private async runLogged(command: string | [string, ...string[]], label: string, cwd = this.git.dir): Promise<void> {
    const result = await runChecked(command, {
      cwd,
      timeoutSeconds: this.config.hooks.timeoutSeconds,
      label,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (output) {
      this.logger.debug('Command output', { command: label, output: output.slice(-4000) });
    }
  }

  private async finish(
    state: UpdaterState,
    target: Target,
    previousCommit: string | undefined,
    outcome: 'deployed' | 'rolled-back' | 'failed',
    commit: string | undefined,
    error?: string
  ): Promise<UpdateResult> {
    const record: DeploymentRecord = {
      outcome,
      ref: target.ref,
      commit: target.commit,
      time: new Date().toISOString(),
    };
    if (previousCommit) record.previousCommit = previousCommit;
    if (error) record.error = error;
    await writeState(this.options.statePath, recordDeployment(state, record));

    const fields: Omit<DeploymentEvent, 'host' | 'time'> = {
      event: EVENT_OF[outcome],
      repository: repositoryLabel(this.config.repo.url),
      ref: target.ref,
    };
    if (commit) fields.commit = commit;
    if (previousCommit) fields.previousCommit = previousCommit;
    if (outcome !== 'deployed') fields.failedCommit = target.commit;
    if (error) fields.error = this.logger.redact(error);
    const notifyOptions: { fetch?: FetchLike; logger: Logger } = { logger: this.logger };
    if (this.options.fetch) notifyOptions.fetch = this.options.fetch;
    await notify(this.config.notifications, createEvent(fields), notifyOptions);

    if (outcome === 'deployed') {
      this.logger.info('Update complete', { ref: target.ref, commit: target.commit });
    }
    const result: UpdateResult = { outcome, target };
    if (previousCommit) result.previousCommit = previousCommit;
    if (commit) result.commit = commit;
    if (error) result.error = error;
    return result;
  }

  /**
   * Goes back to an earlier commit by hand: the given one, or the commit that ran before the last deployment.
   * The rolled-back commit is marked as failed so the next cycle does not deploy it again.
   */
  async rollbackTo(commit?: string): Promise<UpdateResult> {
    if (this.slots) {
      return this.rollbackBlueGreen(this.slots, commit);
    }
    await this.git.prepare();
    const state = this.readState();
    const current = await this.git.head();
    const lastDeployed = state.history.find((record) => record.outcome === 'deployed');
    const destination = commit ?? lastDeployed?.previousCommit;
    if (!destination || !current) {
      throw new SelfUpdaterError(
        'NO_PREVIOUS_COMMIT',
        'There is no earlier deployment to roll back to; pass --to <commit>.'
      );
    }
    if (!(await this.git.hasCommit(destination))) {
      throw new SelfUpdaterError('TARGET_NOT_FOUND', `Commit ${destination} is not in the workspace.`);
    }
    const release = await this.lock();
    try {
      const target: Target = { kind: 'branch', ref: state.lastRef ?? this.config.repo.branch, commit: current };
      await this.git.checkout(destination);
      await this.activate(current, destination, false);
      return await this.finish(state, target, current, 'rolled-back', destination, 'rolled back by hand');
    } finally {
      await release();
    }
  }

  /** Rollback by hand for blue-green: the idle slot gets the commit (usually it has it already), then the link moves. */
  private async rollbackBlueGreen(slots: Slots, commit?: string): Promise<UpdateResult> {
    const state = this.readState();
    const active = slots.active();
    const current = active ? await this.gitAt(slots.dir(active)).head() : undefined;
    const destination = commit ?? state.history.find((record) => record.outcome === 'deployed')?.previousCommit;
    if (!current || !destination) {
      throw new SelfUpdaterError(
        'NO_PREVIOUS_COMMIT',
        'There is no earlier deployment to roll back to; pass --to <commit>.'
      );
    }
    const idle = slots.idle();
    const git = this.gitAt(slots.dir(idle));
    if (!git.isRepository() || !(await git.hasCommit(destination))) {
      throw new SelfUpdaterError('TARGET_NOT_FOUND', `Commit ${destination} is not in ${git.dir}.`);
    }
    const release = await this.lock();
    try {
      const target: Target = { kind: 'branch', ref: state.lastRef ?? this.config.repo.branch, commit: current };
      const before = await git.head();
      if (before !== destination) {
        await git.checkout(destination);
        await this.install(git, before, destination);
      }
      await slots.switchTo(idle);
      await this.restartAndCheck();
      return await this.finish(state, target, current, 'rolled-back', destination, 'rolled back by hand');
    } finally {
      await release();
    }
  }
}
