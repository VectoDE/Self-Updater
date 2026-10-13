// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { Agent } from '../agent.js';
import { expandEnvironment, loadConfig, resolveConfigPath, statePathFor, writeJsonFile } from '../config/load.js';
import {
  CONFIG_VERSION,
  formatIssues,
  migrateConfig,
  parseConfig,
  SERVICE_TYPES,
  type ServiceType,
  type UpdaterConfig,
  type UpdaterConfigInput,
} from '../config/schema.js';
import { isSelfUpdaterError, messageOf } from '../errors.js';
import { Logger } from '../logger.js';
import type { FetchLike } from '../target.js';
import { type UpdateResult, Updater } from '../updater.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Ends "start" when aborted; the CLI wires SIGINT and SIGTERM to it. */
  signal?: AbortSignal;
  fetch?: FetchLike;
}

const EXIT = { ok: 0, failed: 1, usage: 2, rolledBack: 3 } as const;

const HELP = `self-updater ${__VERSION__}: keeps a server checkout in sync with its Git repository.

Usage: self-updater <command> [options]

Commands
  init                  Write a configuration file (see "self-updater init --help")
  start                 Run continuously: poll and/or listen for webhooks
  update                Run one update cycle and exit (alias: run-once)
  status                Compare the checkout with the remote
  rollback              Go back to the commit before the last deployment
  validate              Check the configuration and show problems
  migrate               Convert a 1.x or 2.x configuration file to the current format

Options
  -c, --config <file>   Configuration file (default: $SELF_UPDATER_CONFIG or ./updater.config.json)
      --env-file <file> Load environment variables (default: .env next to the configuration, if present)
      --json            Machine-readable output
  -h, --help            Show help
  -v, --version         Show the version

update:   --force (deploy even if current or failed before), --dry-run
start:    --immediate (run a cycle right away)
rollback: --to <commit>

Exit codes: 0 done, 1 failed, 2 usage or configuration error, 3 rolled back.
Documentation: https://github.com/VectoDE/Self-Updater#readme`;

const INIT_HELP = `Usage: self-updater init --repo <url> --path <dir> --type <type> [options]

Required
  --repo <url>              Git repository (HTTPS or SSH)
  --path <dir>              Directory of the deployed checkout
  --type <type>             ${SERVICE_TYPES.join(' | ')}

Service
  --name <name>             PM2 process, container or systemd unit
  --command <cmd>           Restart command (type "command", or to replace the built-in one)
  --compose-file <file>     Compose file (type "compose")
  --compose-service <name>  Compose service (type "compose")
  --sudo                    Prefix the built-in restart with "sudo -n"

What to deploy
  --branch <name>           Branch to follow (default main)
  --tag-pattern <pattern>   Follow the newest version tag matching it instead, e.g. "v*"
  --prerelease              Include prerelease tags
  --require-signature       Deploy only signed commits or tags
  --token-env <NAME>        Environment variable with the access token (stored as \${NAME})

Steps
  --install                 Install dependencies when they change
  --install-command <cmd>   Install command (default "npm ci")
  --pre <cmd>, --post <cmd> Hooks before the update and after a successful one
  --health-url <url>        URL that must answer 200 after the restart
  --health-command <cmd>    Command that must succeed after the restart
  --no-rollback             Keep a failed version instead of going back

Triggers
  --interval <seconds>      Polling interval (default 60, minimum 15)
  --jitter <seconds>        Random extra delay per poll
  --webhook-port <port>     Also listen for GitHub/GitLab webhooks; the secret comes from
                            SELF_UPDATER_WEBHOOK_SECRET
  --force                   Overwrite an existing configuration file`;

const GLOBAL_OPTIONS = {
  config: { type: 'string', short: 'c' },
  'env-file': { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const satisfies ParseArgsConfig['options'];

const COMMAND_OPTIONS = {
  init: {
    repo: { type: 'string' },
    path: { type: 'string' },
    type: { type: 'string' },
    name: { type: 'string' },
    command: { type: 'string' },
    'compose-file': { type: 'string' },
    'compose-service': { type: 'string' },
    sudo: { type: 'boolean' },
    branch: { type: 'string' },
    'tag-pattern': { type: 'string' },
    prerelease: { type: 'boolean' },
    'require-signature': { type: 'boolean' },
    'token-env': { type: 'string' },
    install: { type: 'boolean' },
    'install-command': { type: 'string' },
    pre: { type: 'string' },
    post: { type: 'string' },
    'health-url': { type: 'string' },
    'health-command': { type: 'string' },
    'no-rollback': { type: 'boolean' },
    interval: { type: 'string' },
    jitter: { type: 'string' },
    'webhook-port': { type: 'string' },
    force: { type: 'boolean' },
  },
  start: { immediate: { type: 'boolean' } },
  update: { force: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
  status: {},
  rollback: { to: { type: 'string' } },
  validate: {},
  migrate: {},
} as const satisfies Record<string, ParseArgsConfig['options']>;

type Command = keyof typeof COMMAND_OPTIONS;
type Options = Record<string, string | boolean | undefined>;

class UsageError extends Error {}

const text = (options: Options, name: string): string | undefined => {
  const value = options[name];
  return typeof value === 'string' ? value : undefined;
};

const integerOption = (value: string | undefined, name: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (!/^\d+$/.test(value)) {
    throw new UsageError(`--${name} must be a whole number`);
  }
  return Number(value);
};

/** Only the entries whose value is set, so optional fields stay absent instead of undefined. */
const present = <T extends Record<string, unknown>>(entries: T): { [K in keyof T]?: Exclude<T[K], undefined> } =>
  Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

interface Context {
  io: CliIo;
  env: NodeJS.ProcessEnv;
  options: Options;
  configPath: string;
  json: boolean;
  print: (value: unknown, output: string) => void;
}

const loggerFor = (config: UpdaterConfig, context: Context): Logger =>
  new Logger({
    level: context.env.SELF_UPDATER_LOG_LEVEL === 'debug' ? 'debug' : config.logging.level,
    format: context.json ? 'json' : config.logging.format,
    ...present({ file: config.logging.file }),
    secrets: [config.repo.token, config.webhook.secret, ...config.notifications.map(({ url }) => url)],
    write: (line, level) => {
      if (level === 'error' || level === 'warn') {
        context.io.stderr(line);
      } else {
        context.io.stdout(line);
      }
    },
  });

/** One NAME=value line of a .env file, or undefined for comments, blank lines and anything else. */
export const parseEnvLine = (line: string): [string, string] | undefined => {
  let content = line.trim();
  if (content === '' || content.startsWith('#')) {
    return undefined;
  }
  if (content.startsWith('export ')) {
    content = content.slice('export '.length).trimStart();
  }
  const separator = content.indexOf('=');
  const name = content.slice(0, Math.max(separator, 0)).trim();
  if (separator <= 0 || !/^[A-Z_]\w*$/i.test(name)) {
    return undefined;
  }
  let value = content.slice(separator + 1).trim();
  const quote = value[0];
  if (value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote)) {
    value = value.slice(1, -1);
  }
  return [name, value];
};

/** Loads .env (explicit or next to the configuration) into the environment without overriding what is set. */
const loadEnvFile = (file: string | undefined, configPath: string, env: NodeJS.ProcessEnv) => {
  const candidate = file ? path.resolve(file) : path.join(path.dirname(configPath), '.env');
  if (!existsSync(candidate)) {
    if (file) {
      throw new UsageError(`--env-file ${file} does not exist`);
    }
    return;
  }
  for (const line of readFileSync(candidate, 'utf8').split(/\r?\n/)) {
    const entry = parseEnvLine(line);
    if (entry) {
      env[entry[0]] ??= entry[1];
    }
  }
};

const initService = (options: Options): UpdaterConfigInput['service'] => ({
  type: text(options, 'type') as ServiceType,
  ...present({
    name: text(options, 'name'),
    command: text(options, 'command'),
    composeFile: text(options, 'compose-file'),
    composeService: text(options, 'compose-service'),
  }),
  sudo: options.sudo === true,
});

const initHealthCheck = (options: Options): Pick<UpdaterConfigInput, 'healthCheck'> => {
  const check = present({ url: text(options, 'health-url'), command: text(options, 'health-command') });
  return Object.keys(check).length > 0 ? { healthCheck: check } : {};
};

const initWebhook = (options: Options): Pick<UpdaterConfigInput, 'webhook'> => {
  const port = integerOption(text(options, 'webhook-port'), 'webhook-port');
  return port === undefined ? {} : { webhook: { enabled: true, port, secret: '${SELF_UPDATER_WEBHOOK_SECRET}' } };
};

/** The configuration "init" writes, from its command-line options. */
export const buildInitConfig = (options: Options): UpdaterConfigInput => {
  const repo = text(options, 'repo');
  const workspacePath = text(options, 'path');
  const missing = ['repo', 'path', 'type'].filter((name) => text(options, name) === undefined);
  if (missing.length > 0 || !repo || !workspacePath) {
    const flags = missing.map((name) => `--${name}`).join(', ');
    throw new UsageError(`init needs ${flags}. See "self-updater init --help".`);
  }
  const tokenEnv = text(options, 'token-env');
  if (tokenEnv !== undefined && !/^[A-Z_]\w*$/i.test(tokenEnv)) {
    throw new UsageError('--token-env must be the name of an environment variable, e.g. GITHUB_TOKEN');
  }
  const tagPattern = text(options, 'tag-pattern');
  return {
    version: CONFIG_VERSION,
    repo: { url: repo, ...present({ branch: text(options, 'branch'), token: tokenEnv && `\${${tokenEnv}}` }) },
    track: {
      mode: tagPattern ? 'tag' : 'branch',
      ...present({ tagPattern }),
      prerelease: options.prerelease === true,
      requireSignature: options['require-signature'] === true,
    },
    workspace: {
      path: workspacePath,
      install: { enabled: options.install === true, ...present({ command: text(options, 'install-command') }) },
    },
    service: initService(options),
    hooks: present({ preUpdate: text(options, 'pre'), postUpdate: text(options, 'post') }),
    ...initHealthCheck(options),
    rollback: { enabled: options['no-rollback'] !== true },
    schedule: {
      intervalSeconds: integerOption(text(options, 'interval'), 'interval') ?? 60,
      jitterSeconds: integerOption(text(options, 'jitter'), 'jitter') ?? 0,
    },
    ...initWebhook(options),
    logging: { level: 'info' },
  };
};

/** Placeholder values for every ${NAME} the generated configuration refers to, so it can be checked before use. */
const placeholders = (input: unknown): NodeJS.ProcessEnv =>
  Object.fromEntries(
    [...JSON.stringify(input).matchAll(/\$\{([A-Z_]\w*)\}/gi)].map((match) => [match[1] ?? '', 'x'.repeat(32)])
  );

const describeResult = (result: UpdateResult): string => {
  const commit = result.commit?.slice(0, 12) ?? 'nothing';
  const ref = result.target ? `${result.target.ref} @ ${result.target.commit.slice(0, 12)}` : '';
  const error = result.error ?? '';
  switch (result.outcome) {
    case 'up-to-date':
      return `Up to date: ${ref}`;
    case 'skipped':
      return `Skipped ${ref}: it failed before. Push a fix or run "self-updater update --force".`;
    case 'dry-run':
      return `Update available: ${ref} (currently ${commit})`;
    case 'deployed':
      return `Deployed ${ref}`;
    case 'rolled-back':
      return `Deployment of ${ref} failed and was rolled back to ${commit}: ${error}`;
    default:
      return `Deployment of ${ref} failed: ${error}`;
  }
};

const EXIT_BY_OUTCOME: Record<UpdateResult['outcome'], number> = {
  'up-to-date': EXIT.ok,
  skipped: EXIT.ok,
  'dry-run': EXIT.ok,
  deployed: EXIT.ok,
  'rolled-back': EXIT.rolledBack,
  failed: EXIT.failed,
};

const runInit = async ({ options, configPath, env, print }: Context): Promise<number> => {
  if (existsSync(configPath) && options.force !== true) {
    throw new UsageError(`${configPath} exists already. Use --force to overwrite it.`);
  }
  const input = buildInitConfig(options);
  // Check the file with placeholder values for the variables it refers to.
  const result = parseConfig(expandEnvironment(input, { ...env, ...placeholders(input) }));
  if (!result.ok) {
    throw new UsageError(`The configuration would be invalid:\n${formatIssues(result.issues)}`);
  }
  await writeJsonFile(configPath, input);
  print({ path: configPath, config: input }, `Configuration written to ${configPath}`);
  return EXIT.ok;
};

const runMigrate = async ({ configPath, print }: Context): Promise<number> => {
  if (!existsSync(configPath)) {
    throw new UsageError(`No configuration at ${configPath}.`);
  }
  const { raw, migrated } = migrateConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  if (!migrated) {
    print({ path: configPath, migrated: false }, `${configPath} already uses version ${CONFIG_VERSION}.`);
    return EXIT.ok;
  }
  const backup = `${configPath}.bak`;
  await copyFile(configPath, backup);
  await writeJsonFile(configPath, raw);
  print(
    { path: configPath, backup, migrated: true, config: raw },
    `Converted ${configPath} to version ${CONFIG_VERSION}; the original is in ${backup}. ` +
      'Rollback stays off as in 2.x; turn it on with "rollback": { "enabled": true }.'
  );
  return EXIT.ok;
};

const runStatus = async (updater: Updater, { print }: Context): Promise<number> => {
  const status = await updater.status();
  const lines = [
    status.updateAvailable ? 'Update available' : 'Up to date',
    `Deployed: ${status.current ?? 'nothing yet'}`,
    `Remote:   ${status.target.commit} (${status.target.kind} ${status.target.ref})`,
  ];
  if (status.skipped) {
    lines.push('The remote commit failed before and is skipped until a newer one arrives.');
  }
  if (status.state.updatedAt) {
    lines.push(`Last update: ${status.state.updatedAt}`);
  }
  print(status, lines.join('\n'));
  return EXIT.ok;
};

const untilAborted = (signal: AbortSignal | undefined): Promise<void> =>
  new Promise((resolve) => {
    if (!signal || signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        resolve();
      },
      { once: true }
    );
  });

const runStart = async (updater: Updater, logger: Logger, { io, options }: Context): Promise<number> => {
  const agent = new Agent(updater, { logger, immediate: options.immediate === true });
  await agent.start();
  await untilAborted(io.signal);
  await agent.stop();
  return EXIT.ok;
};

/** Commands that work on a loaded configuration. */
const runWithConfig = async (command: Command, context: Context): Promise<number> => {
  const { configPath, env, options, print } = context;
  loadEnvFile(text(options, 'env-file'), configPath, env);
  const loaded = loadConfig(configPath, env);
  if (command === 'validate') {
    const note = loaded.migrated ? ' (older format; "self-updater migrate" converts it)' : '';
    print({ valid: true, path: configPath, migrated: loaded.migrated }, `${configPath} is valid${note}.`);
    return EXIT.ok;
  }
  const logger = loggerFor(loaded.config, context);
  if (loaded.migrated) {
    logger.warn(`${configPath} uses an older format; run "self-updater migrate" to convert it.`);
  }
  const updater = new Updater(loaded.config, {
    statePath: statePathFor(configPath),
    logger,
    ...present({ fetch: context.io.fetch }),
  });
  switch (command) {
    case 'status':
      return runStatus(updater, context);
    case 'update': {
      const result = await updater.update({ force: options.force === true, dryRun: options['dry-run'] === true });
      print(result, describeResult(result));
      return EXIT_BY_OUTCOME[result.outcome];
    }
    case 'rollback': {
      const result = await updater.rollbackTo(text(options, 'to'));
      print(result, `Rolled back to ${result.commit ?? 'unknown'}.`);
      return EXIT.ok;
    }
    default:
      return runStart(updater, logger, context);
  }
};

const reportError = (error: unknown, io: CliIo, json: boolean): number => {
  // node:util parseArgs reports unknown options, missing values and stray arguments with ERR_PARSE_ARGS_* codes.
  const nodeCode = error instanceof Error && 'code' in error ? String(error.code) : '';
  const usage = error instanceof UsageError || nodeCode.startsWith('ERR_PARSE_ARGS_');
  let code = 'ERROR';
  if (isSelfUpdaterError(error)) {
    code = error.code;
  } else if (usage) {
    code = 'USAGE';
  }
  const message = messageOf(error);
  io.stderr(json ? JSON.stringify({ error: { code, message } }) : `self-updater: ${message}`);
  return usage || code.startsWith('CONFIG_') ? EXIT.usage : EXIT.failed;
};

/** Runs the command line with the given arguments (without "node" and the script) and returns the exit code. */
export const runCli = async (argv: readonly string[], io: CliIo): Promise<number> => {
  const env = io.env ?? process.env;
  const commandName = argv.find((arg) => !arg.startsWith('-'));
  const command = (commandName === 'run-once' ? 'update' : commandName) as Command | undefined;
  let json = argv.includes('--json');
  try {
    if (command !== undefined && !Object.hasOwn(COMMAND_OPTIONS, command)) {
      throw new UsageError(`Unknown command "${commandName ?? ''}". Run "self-updater --help".`);
    }
    const { values } = parseArgs({
      args: [...argv],
      options: { ...GLOBAL_OPTIONS, ...(command ? COMMAND_OPTIONS[command] : {}) },
      allowPositionals: true,
      strict: true,
    });
    const options = values as Options;
    json = options.json === true;
    if (options.version) {
      io.stdout(__VERSION__);
      return EXIT.ok;
    }
    if (options.help || !command) {
      io.stdout(command === 'init' ? INIT_HELP : HELP);
      return command || options.help ? EXIT.ok : EXIT.usage;
    }
    const context: Context = {
      io,
      env,
      options,
      json,
      configPath: resolveConfigPath(text(options, 'config'), env),
      print: (value, output) => {
        io.stdout(json ? JSON.stringify(value, null, 2) : output);
      },
    };
    if (command === 'init') {
      return await runInit(context);
    }
    if (command === 'migrate') {
      return await runMigrate(context);
    }
    return await runWithConfig(command, context);
  } catch (error) {
    return reportError(error, io, json);
  }
};
