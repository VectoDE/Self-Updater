// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

// Public API of @vectode/self-updater. The CLI is a thin layer over these.
export { Agent, type AgentOptions } from './agent.js';
export {
  DEFAULT_CONFIG_FILE,
  expandEnvironment,
  loadConfig,
  type LoadedConfig,
  resolveConfigPath,
  statePathFor,
} from './config/load.js';
export * from './config/schema.js';
export { type ErrorCode, isSelfUpdaterError, SelfUpdaterError } from './errors.js';
export { describeCommand, run, runChecked, type RunOptions, type RunResult } from './exec.js';
export { detectProvider, Git, gitEnvironment, type RemoteRef } from './git.js';
export { checkHealth, type HealthCheckOptions } from './health.js';
export { acquireLock } from './lock.js';
export { type LogFields, Logger, type LoggerOptions, type LogRecord, silentLogger } from './logger.js';
export { createEvent, type DeploymentEvent, notify, payloadFor, summarize } from './notify.js';
export { compareSemVer, newestTag, parseSemVer, type SemVer, tagMatcher } from './semver.js';
export { restartCommand } from './service.js';
export { type DeploymentOutcome, type DeploymentRecord, readState, type UpdaterState } from './state.js';
export { branchApiRequest, type FetchLike, type Target, TargetResolver } from './target.js';
export {
  repositoryLabel,
  type StatusReport,
  type UpdateOptions,
  type UpdateOutcome,
  type UpdateResult,
  Updater,
  type UpdaterOptions,
} from './updater.js';
export {
  judgeDelivery,
  startWebhookServer,
  verifyGitHubSignature,
  verifyGitLabToken,
  type WebhookServer,
  type WebhookVerdict,
} from './webhook.js';
