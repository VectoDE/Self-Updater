// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

// The configuration format (version 3), its defaults, validation and the migration from older formats. No Node.js
// APIs here: the configuration builder on the project site runs the same checks in the browser.

export const CONFIG_VERSION = 3;

export type ServiceType = 'pm2' | 'docker' | 'compose' | 'systemd' | 'command' | 'none';
export type TrackMode = 'branch' | 'tag';
export type ProviderType = 'auto' | 'github' | 'gitlab' | 'git';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export type LogFormat = 'text' | 'json';
export type NotificationType = 'slack' | 'discord' | 'webhook';
export type NotificationEvent = 'success' | 'failure' | 'rollback';
export type InstallWhen = 'changed' | 'always';

export interface RepoConfig {
  /** HTTPS or SSH URL of the repository. */
  url: string;
  /** Branch to follow in branch mode. */
  branch: string;
  remote: string;
  /** Token for private repositories and provider APIs. Sent only to the repository host, never logged. */
  token?: string;
  /** Where to ask for the newest commit: the GitHub or GitLab API, or plain git (auto picks by host name). */
  provider: ProviderType;
  /** API base URL for GitHub Enterprise or self-hosted GitLab, e.g. https://gitlab.example.com/api/v4. */
  apiUrl?: string;
}

export interface TrackConfig {
  /** Deploy the head of the branch, or the newest version tag. */
  mode: TrackMode;
  /** Tags considered in tag mode; "*" matches any characters. */
  tagPattern: string;
  /** Allow prerelease versions such as 2.0.0-rc.1 in tag mode. */
  prerelease: boolean;
  /** Deploy only commits (branch mode) or tags (tag mode) with a valid signature. */
  requireSignature: boolean;
  /** SSH allowed signers file for signature checks; without it, git's own GPG/SSH configuration applies. */
  allowedSigners?: string;
}

export interface InstallConfig {
  enabled: boolean;
  command: string;
  /** "changed": only when one of the watched files changed; "always": after every update. */
  when: InstallWhen;
  watch: string[];
}

export interface WorkspaceConfig {
  /** Directory of the deployed checkout. Created and cloned when it does not exist or is empty. */
  path: string;
  shallow: boolean;
  install: InstallConfig;
}

export interface ServiceConfig {
  type: ServiceType;
  /** PM2 process, Docker container or systemd unit name. */
  name?: string;
  composeFile?: string;
  composeService?: string;
  /** Restart command for type "command"; overrides the built-in restart for every other type. */
  command?: string;
  /** Prefix built-in restarts with "sudo -n" (systemd units of other users, Docker without group access). */
  sudo: boolean;
}

export interface HooksConfig {
  /** Runs in the workspace before the code changes; a failure cancels the update. */
  preUpdate?: string;
  /** Runs after a successful restart and health check. */
  postUpdate?: string;
  timeoutSeconds: number;
}

export interface HealthCheckConfig {
  /** URL that must answer with expectStatus. */
  url?: string;
  /** Command that must exit with 0. */
  command?: string;
  expectStatus: number;
  timeoutSeconds: number;
  retries: number;
  intervalSeconds: number;
  /** Wait before the first attempt, for services that need time to start. */
  startDelaySeconds: number;
}

export interface RollbackConfig {
  /** Go back to the previous commit when installing, restarting or the health check fails. */
  enabled: boolean;
}

export interface ScheduleConfig {
  /** Poll for new commits; turn off to rely on the webhook only. */
  enabled: boolean;
  intervalSeconds: number;
  jitterSeconds: number;
}

export interface WebhookConfig {
  enabled: boolean;
  host: string;
  port: number;
  path: string;
  /** GitHub webhook secret or GitLab secret token; requests without the right one are rejected. */
  secret?: string;
}

export interface NotificationConfig {
  type: NotificationType;
  url: string;
  events: NotificationEvent[];
}

export interface LoggingConfig {
  level: LogLevel;
  format: LogFormat;
  file?: string;
}

export interface UpdaterConfig {
  version: typeof CONFIG_VERSION;
  repo: RepoConfig;
  track: TrackConfig;
  workspace: WorkspaceConfig;
  service: ServiceConfig;
  hooks: HooksConfig;
  healthCheck?: HealthCheckConfig;
  rollback: RollbackConfig;
  schedule: ScheduleConfig;
  webhook: WebhookConfig;
  notifications: NotificationConfig[];
  logging: LoggingConfig;
}

/** What a configuration file may contain: everything optional except what has no sensible default. */
export interface UpdaterConfigInput {
  version?: number;
  repo: Partial<RepoConfig> & { url: string };
  track?: Partial<TrackConfig>;
  workspace: Partial<Omit<WorkspaceConfig, 'install'>> & { path: string; install?: Partial<InstallConfig> };
  service: Partial<ServiceConfig> & { type: ServiceType };
  hooks?: Partial<HooksConfig>;
  healthCheck?: Partial<HealthCheckConfig>;
  rollback?: Partial<RollbackConfig>;
  schedule?: Partial<ScheduleConfig>;
  webhook?: Partial<WebhookConfig>;
  notifications?: (Partial<NotificationConfig> & { type: NotificationType; url: string })[];
  logging?: Partial<LoggingConfig>;
}

export const SERVICE_TYPES: readonly ServiceType[] = ['pm2', 'docker', 'compose', 'systemd', 'command', 'none'];
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug'];
export const NOTIFICATION_EVENTS: readonly NotificationEvent[] = ['success', 'failure', 'rollback'];
const PROVIDERS: readonly ProviderType[] = ['auto', 'github', 'gitlab', 'git'];
const NOTIFICATION_TYPES: readonly NotificationType[] = ['slack', 'discord', 'webhook'];

export const DEFAULT_INSTALL_WATCH = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

/** One problem in a configuration, with the dotted path of the field. */
export interface ConfigIssue {
  path: string;
  message: string;
}

export type ConfigResult =
  { ok: true; config: UpdaterConfig; migrated: boolean } | { ok: false; issues: ConfigIssue[] };

type Raw = Record<string, unknown>;

/** A pattern or a predicate a string value must satisfy. */
type Check = RegExp | ((value: string) => boolean);

const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Names of processes, containers and units go into argument lists; keep them to plain characters. */
const NAME = /^[\w.@:-]{1,200}$/;
const BRANCH = /^(?!-)(?!.*\.\.)[\w./-]{1,200}$/;
const REMOTE = /^[\w.-]{1,100}$/;

/** Shortest webhook secret; `openssl rand -hex 32` gives 64 characters. */
export const MIN_WEBHOOK_SECRET = 32;

class Reader {
  readonly issues: ConfigIssue[] = [];

  constructor(private readonly root: Raw) {}

  private at(path: string): unknown {
    let value: unknown = this.root;
    for (const key of path.split('.')) {
      if (Array.isArray(value) && /^\d+$/.test(key)) {
        value = value[Number(key)];
      } else {
        value = isObject(value) ? value[key] : undefined;
      }
    }
    return value;
  }

  issue(path: string, message: string) {
    // A missing or broken section is reported once, not again for every field inside it.
    if (!this.issues.some((issue) => issue.path !== '' && path.startsWith(`${issue.path}.`))) {
      this.issues.push({ path, message });
    }
  }

  string(path: string, fallback?: string, check?: Check, hint = 'has an invalid format'): string | undefined {
    const value = this.at(path);
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    if (typeof value !== 'string') {
      this.issue(path, 'must be a string');
      return fallback;
    }
    if (value.length > 4096) {
      this.issue(path, 'is longer than 4096 characters');
      return fallback;
    }
    if (check && !(typeof check === 'function' ? check(value) : check.test(value))) {
      this.issue(path, hint);
    }
    return value;
  }

  required(path: string, check?: Check, hint?: string): string {
    const before = this.issues.length;
    const value = this.string(path, undefined, check, hint);
    // Report a missing value only when string() did not already explain what is wrong with it.
    if (value === undefined && this.issues.length === before) {
      this.issue(path, 'is required');
    }
    return value ?? '';
  }

  boolean(path: string, fallback: boolean): boolean {
    const value = this.at(path);
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      this.issue(path, 'must be true or false');
      return fallback;
    }
    return value;
  }

  integer(path: string, fallback: number, min: number, max: number): number {
    const value = this.at(path);
    if (value === undefined || value === null) {
      return fallback;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.issue(path, `must be a whole number from ${min} to ${max}`);
      return fallback;
    }
    return value;
  }

  choice<T extends string>(path: string, options: readonly T[], fallback: T): T {
    const value = this.at(path);
    if (value === undefined || value === null || value === '') {
      return fallback;
    }
    if (typeof value !== 'string' || !(options as readonly string[]).includes(value)) {
      this.issue(path, `must be one of ${options.join(', ')}`);
      return fallback;
    }
    return value as T;
  }

  strings(path: string, fallback: string[]): string[] {
    const value = this.at(path);
    if (value === undefined || value === null) {
      return fallback;
    }
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
      this.issue(path, 'must be a list of non-empty strings');
      return fallback;
    }
    return value as string[];
  }

  section(path: string): Raw | undefined {
    const value = this.at(path);
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!isObject(value)) {
      this.issue(path, 'must be an object');
      return undefined;
    }
    return value;
  }
}

const isHttpUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
};

/** Accepts https://, http://, ssh://, git:// and file:// URLs, scp-like git@host:path and local paths. */
export const isRepositoryUrl = (value: string): boolean => {
  if (value.startsWith('-') || /\s/.test(value)) {
    return false;
  }
  if (/^[\w.-]+@[\w.-]+:[^:]/.test(value)) {
    return true;
  }
  if (/^[a-z][\w+.-]*:\/\//i.test(value)) {
    try {
      return ['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  // A local path such as /srv/repos/app.git or C:\repos\app (useful for mirrors and tests).
  return value.length > 0;
};

const readService = (r: Reader): ServiceConfig => {
  const type = r.choice('service.type', SERVICE_TYPES, 'none');
  const service: ServiceConfig = {
    type,
    sudo: r.boolean('service.sudo', false),
  };
  const name = r.string('service.name', undefined, NAME, 'may only contain letters, digits and . _ - @ :');
  const command = r.string('service.command');
  const composeFile = r.string('service.composeFile');
  const composeService = r.string(
    'service.composeService',
    undefined,
    NAME,
    'may only contain letters, digits and . _ - @ :'
  );
  if (name !== undefined) service.name = name;
  if (command !== undefined) service.command = command;
  if (composeFile !== undefined) service.composeFile = composeFile;
  if (composeService !== undefined) service.composeService = composeService;

  if ((type === 'pm2' || type === 'docker' || type === 'systemd') && !name && !command) {
    r.issue('service.name', `is required for ${type} services`);
  }
  if (type === 'compose' && !composeService && !name && !command) {
    r.issue('service.composeService', 'is required for compose services');
  }
  if (type === 'command' && !command) {
    r.issue('service.command', 'is required for command services');
  }
  return service;
};

const readHealthCheck = (r: Reader): HealthCheckConfig | undefined => {
  if (!r.section('healthCheck')) {
    return undefined;
  }
  const check: HealthCheckConfig = {
    expectStatus: r.integer('healthCheck.expectStatus', 200, 100, 599),
    timeoutSeconds: r.integer('healthCheck.timeoutSeconds', 10, 1, 600),
    retries: r.integer('healthCheck.retries', 5, 0, 100),
    intervalSeconds: r.integer('healthCheck.intervalSeconds', 5, 1, 600),
    startDelaySeconds: r.integer('healthCheck.startDelaySeconds', 0, 0, 600),
  };
  const url = r.string('healthCheck.url');
  const command = r.string('healthCheck.command');
  if (url !== undefined) {
    if (!isHttpUrl(url)) {
      r.issue('healthCheck.url', 'must be an http or https URL');
    } else if (new URL(url).username !== '' || new URL(url).password !== '') {
      // fetch refuses such URLs, and the credentials would end up in error messages.
      r.issue('healthCheck.url', 'must not contain a user name or password');
    }
    check.url = url;
  }
  if (command !== undefined) check.command = command;
  if (url === undefined && command === undefined) {
    r.issue('healthCheck', 'needs a url or a command');
  }
  return check;
};

const readNotifications = (r: Reader, raw: Raw): NotificationConfig[] => {
  const list = raw.notifications;
  if (list === undefined || list === null) {
    return [];
  }
  if (!Array.isArray(list)) {
    r.issue('notifications', 'must be a list');
    return [];
  }
  return list.map((_, index) => {
    const path = `notifications.${index}`;
    const url = r.required(`${path}.url`);
    if (url && !isHttpUrl(url)) {
      r.issue(`${path}.url`, 'must be an http or https URL');
    }
    const events = r.strings(`${path}.events`, [...NOTIFICATION_EVENTS]);
    for (const event of events) {
      if (!(NOTIFICATION_EVENTS as readonly string[]).includes(event)) {
        r.issue(`${path}.events`, `may only contain ${NOTIFICATION_EVENTS.join(', ')}`);
      }
    }
    return {
      type: r.choice(`${path}.type`, NOTIFICATION_TYPES, 'webhook'),
      url,
      events: events as NotificationEvent[],
    };
  });
};

/** Removes trailing slashes without a regular expression (no backtracking on long input). */
export const trimTrailingSlashes = (value: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') {
    end--;
  }
  return value.slice(0, end);
};

const readRepo = (r: Reader): RepoConfig => {
  const repo: RepoConfig = {
    url: r.required('repo.url', isRepositoryUrl, 'must be a git URL or path'),
    branch: r.string('repo.branch', 'main', BRANCH, 'is not a valid branch name') ?? 'main',
    remote: r.string('repo.remote', 'origin', REMOTE, 'is not a valid remote name') ?? 'origin',
    provider: r.choice('repo.provider', PROVIDERS, 'auto'),
  };
  const token = r.string('repo.token');
  const apiUrl = r.string('repo.apiUrl');
  if (token !== undefined) repo.token = token;
  if (apiUrl !== undefined) {
    if (!isHttpUrl(apiUrl)) {
      r.issue('repo.apiUrl', 'must be an http or https URL');
    }
    repo.apiUrl = trimTrailingSlashes(apiUrl);
  }
  return repo;
};

const readTrack = (r: Reader): TrackConfig => {
  const track: TrackConfig = {
    mode: r.choice('track.mode', ['branch', 'tag'] as const, 'branch'),
    tagPattern: r.string('track.tagPattern', 'v*') ?? 'v*',
    prerelease: r.boolean('track.prerelease', false),
    requireSignature: r.boolean('track.requireSignature', false),
  };
  const allowedSigners = r.string('track.allowedSigners');
  if (allowedSigners !== undefined) track.allowedSigners = allowedSigners;
  return track;
};

const readWorkspace = (r: Reader): WorkspaceConfig => ({
  path: r.required('workspace.path'),
  shallow: r.boolean('workspace.shallow', false),
  install: {
    enabled: r.boolean('workspace.install.enabled', false),
    command: r.string('workspace.install.command', 'npm ci') ?? 'npm ci',
    when: r.choice('workspace.install.when', ['changed', 'always'] as const, 'changed'),
    watch: r.strings('workspace.install.watch', [...DEFAULT_INSTALL_WATCH]),
  },
});

const readHooks = (r: Reader): HooksConfig => {
  const hooks: HooksConfig = { timeoutSeconds: r.integer('hooks.timeoutSeconds', 600, 1, 86_400) };
  const preUpdate = r.string('hooks.preUpdate');
  const postUpdate = r.string('hooks.postUpdate');
  if (preUpdate !== undefined) hooks.preUpdate = preUpdate;
  if (postUpdate !== undefined) hooks.postUpdate = postUpdate;
  return hooks;
};

const WEBHOOK_PATH = /^\/[\w./-]*$/;

const readWebhook = (r: Reader): WebhookConfig => {
  const webhook: WebhookConfig = {
    enabled: r.boolean('webhook.enabled', false),
    host: r.string('webhook.host', '127.0.0.1') ?? '127.0.0.1',
    port: r.integer('webhook.port', 9000, 1, 65_535),
    path:
      r.string(
        'webhook.path',
        '/hooks/self-updater',
        WEBHOOK_PATH,
        'must start with / and contain no spaces or query'
      ) ?? '/hooks/self-updater',
  };
  const secret = r.string('webhook.secret');
  if (secret !== undefined) webhook.secret = secret;
  if (webhook.enabled && (secret === undefined || secret.length < MIN_WEBHOOK_SECRET)) {
    r.issue(
      'webhook.secret',
      `is required when the webhook is enabled and must have at least ${MIN_WEBHOOK_SECRET} characters`
    );
  }
  return webhook;
};

const readSchedule = (r: Reader, webhookEnabled: boolean): ScheduleConfig => {
  const schedule: ScheduleConfig = {
    enabled: r.boolean('schedule.enabled', true),
    intervalSeconds: r.integer('schedule.intervalSeconds', 60, 15, 604_800),
    jitterSeconds: r.integer('schedule.jitterSeconds', 0, 0, 86_400),
  };
  if (!schedule.enabled && !webhookEnabled) {
    r.issue(
      'schedule.enabled',
      'can only be false when the webhook is enabled, or nothing would ever trigger an update'
    );
  }
  return schedule;
};

const readLogging = (r: Reader): LoggingConfig => {
  const logging: LoggingConfig = {
    level: r.choice('logging.level', LOG_LEVELS, 'info'),
    format: r.choice('logging.format', ['text', 'json'] as const, 'text'),
  };
  const file = r.string('logging.file');
  if (file !== undefined) logging.file = file;
  return logging;
};

const readConfig = (raw: Raw): { config: UpdaterConfig; issues: ConfigIssue[] } => {
  const r = new Reader(raw);
  for (const key of ['repo', 'workspace', 'service']) {
    if (!r.section(key)) {
      r.issue(key, 'is required');
    }
  }
  for (const key of ['track', 'hooks', 'rollback', 'schedule', 'webhook', 'logging', 'workspace.install']) {
    r.section(key);
  }
  const webhook = readWebhook(r);
  const config: UpdaterConfig = {
    version: CONFIG_VERSION,
    repo: readRepo(r),
    track: readTrack(r),
    workspace: readWorkspace(r),
    service: readService(r),
    hooks: readHooks(r),
    rollback: { enabled: r.boolean('rollback.enabled', true) },
    schedule: readSchedule(r, webhook.enabled),
    webhook,
    notifications: readNotifications(r, raw),
    logging: readLogging(r),
  };
  const healthCheck = readHealthCheck(r);
  if (healthCheck) config.healthCheck = healthCheck;
  return { config, issues: r.issues };
};

const defined = (value: Raw): Raw =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));

/** Turns a 2.x configuration (version 2) into the current format. */
const fromVersion2 = (raw: Raw): Raw => {
  const repo = isObject(raw.repo) ? raw.repo : {};
  const workspace = isObject(raw.workspace) ? raw.workspace : {};
  const service = isObject(raw.service) ? raw.service : {};
  const schedule = isObject(raw.schedule) ? raw.schedule : {};
  const hooks = isObject(raw.hooks) ? raw.hooks : {};
  const logging = isObject(raw.logging) ? raw.logging : {};
  const compose = service.type === 'docker' && service.dockerCompose === true;
  const restart = typeof service.restartCommand === 'string' ? service.restartCommand : undefined;
  return {
    version: CONFIG_VERSION,
    repo: defined({ url: repo.url, branch: repo.branch, remote: repo.remote, token: repo.authToken }),
    workspace: defined({
      path: workspace.localPath,
      shallow: workspace.shallowClone,
      install: defined({
        enabled: workspace.autoInstall,
        // 2.x defaulted to "npm install"; keep what existing setups ran.
        command: workspace.installCommand ?? 'npm install',
      }),
    }),
    service: defined({
      type: compose ? 'compose' : service.type,
      name: service.name,
      command: restart,
      composeFile: compose ? service.dockerComposeFile : undefined,
      composeService: compose ? (service.dockerComposeService ?? service.name) : undefined,
    }),
    schedule: defined({ intervalSeconds: schedule.intervalSeconds, jitterSeconds: schedule.jitterSeconds }),
    hooks: defined({ preUpdate: hooks.preUpdate, postUpdate: hooks.postUpdate }),
    // 2.x had no rollback; turning it on silently would change how failed deployments behave.
    rollback: { enabled: false },
    logging: defined({ level: logging.level, file: logging.file }),
  };
};

/** Turns a 1.x configuration (flat, without version) into the 2.x shape, then into the current one. */
const fromVersion1 = (raw: Raw): Raw =>
  fromVersion2({
    version: 2,
    repo: { url: raw.repoUrl, branch: raw.branch, authToken: raw.authToken },
    workspace: {
      localPath: raw.localPath,
      autoInstall: raw.autoInstall,
      installCommand: raw.installCommand,
      shallowClone: raw.shallowClone,
    },
    service: {
      type: raw.serviceType,
      name: raw.serviceName,
      restartCommand: raw.restartCommand,
      dockerCompose: raw.dockerCompose,
      dockerComposeService: raw.dockerComposeService,
      dockerComposeFile: raw.dockerComposeFile,
    },
    schedule: { intervalSeconds: raw.checkInterval, jitterSeconds: raw.jitterSeconds },
    hooks: { preUpdate: raw.preUpdateCommand, postUpdate: raw.postUpdateCommand },
    logging: { level: raw.logLevel, file: raw.logFile },
  });

/** Brings any supported configuration to the current version without validating it. */
export const migrateConfig = (raw: unknown): { raw: unknown; migrated: boolean } => {
  if (!isObject(raw)) {
    return { raw, migrated: false };
  }
  if (raw.version === undefined && 'repoUrl' in raw) {
    return { raw: fromVersion1(raw), migrated: true };
  }
  if (raw.version === 2) {
    return { raw: fromVersion2(raw), migrated: true };
  }
  return { raw, migrated: false };
};

/**
 * Validates a configuration (any supported version) and fills in the defaults. Reports every problem at once
 * instead of stopping at the first.
 */
export const parseConfig = (input: unknown): ConfigResult => {
  const { raw, migrated } = migrateConfig(input);
  if (!isObject(raw)) {
    return { ok: false, issues: [{ path: '', message: 'must be a JSON object' }] };
  }
  if (raw.version !== undefined && raw.version !== CONFIG_VERSION) {
    return { ok: false, issues: [{ path: 'version', message: `must be ${CONFIG_VERSION} (or 2 to migrate)` }] };
  }
  const { config, issues } = readConfig(raw);
  return issues.length > 0 ? { ok: false, issues } : { ok: true, config, migrated };
};

/** Typed helper for configuration written in JavaScript or TypeScript. */
export const defineConfig = (config: UpdaterConfigInput): UpdaterConfigInput => config;

export const formatIssues = (issues: readonly ConfigIssue[]): string =>
  issues.map(({ path, message }) => `- ${path === '' ? 'configuration' : path} ${message}`).join('\n');
