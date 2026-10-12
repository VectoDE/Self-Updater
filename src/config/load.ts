import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SelfUpdaterError } from '../errors.js';
import { formatIssues, parseConfig, type UpdaterConfig } from './schema.js';

export const DEFAULT_CONFIG_FILE = 'updater.config.json';

/** The configuration file: an explicit path, SELF_UPDATER_CONFIG, or updater.config.json in the working directory. */
export const resolveConfigPath = (file?: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.resolve(file ?? env.SELF_UPDATER_CONFIG ?? DEFAULT_CONFIG_FILE);

/** The state file lives next to the configuration. */
export const statePathFor = (configPath: string): string => path.join(path.dirname(configPath), 'updater.state.json');

const VARIABLE = /\$\{([A-Z_][A-Z\d_]*)(?::-([^$}]*))?\}/gi;

/**
 * Replaces ${NAME} and ${NAME:-default} in every string, so tokens and secrets can stay in the environment. A
 * variable that is not set and has no default is an error; "$${NAME}" keeps the text literally.
 */
export const expandEnvironment = (value: unknown, env: NodeJS.ProcessEnv = process.env): unknown => {
  const missing = new Set<string>();
  const expand = (item: unknown): unknown => {
    if (typeof item === 'string') {
      return item
        .replaceAll(VARIABLE, (match, name: string, fallback: string | undefined, offset: number) => {
          if (offset > 0 && item[offset - 1] === '$') {
            return match;
          }
          const resolved = env[name];
          if (resolved !== undefined && resolved !== '') {
            return resolved;
          }
          if (fallback !== undefined) {
            return fallback;
          }
          missing.add(name);
          return '';
        })
        .replaceAll('$${', '${');
    }
    if (Array.isArray(item)) {
      return item.map((entry) => expand(entry));
    }
    if (typeof item === 'object' && item !== null) {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, expand(entry)]));
    }
    return item;
  };
  const result = expand(value);
  if (missing.size > 0) {
    throw new SelfUpdaterError(
      'CONFIG_ENV_MISSING',
      `The configuration uses environment variables that are not set: ${[...missing].join(', ')}`
    );
  }
  return result;
};

const absolute = (base: string, file: string) => path.resolve(base, file);

/** Makes every path in the configuration absolute, relative to the directory of the configuration file. */
export const resolvePaths = (config: UpdaterConfig, baseDir: string): UpdaterConfig => {
  const resolved: UpdaterConfig = {
    ...config,
    workspace: { ...config.workspace, path: absolute(baseDir, config.workspace.path) },
    logging: { ...config.logging },
    track: { ...config.track },
  };
  if (config.logging.file) {
    resolved.logging.file = absolute(baseDir, config.logging.file);
  }
  if (config.track.allowedSigners) {
    resolved.track.allowedSigners = absolute(baseDir, config.track.allowedSigners);
  }
  return resolved;
};

export interface LoadedConfig {
  config: UpdaterConfig;
  path: string;
  /** True when the file was written for 2.x or 1.x and converted while loading. */
  migrated: boolean;
}

/** Reads, expands, validates and resolves a configuration file. */
export const loadConfig = (file?: string, env: NodeJS.ProcessEnv = process.env): LoadedConfig => {
  const configPath = resolveConfigPath(file, env);
  if (!existsSync(configPath)) {
    throw new SelfUpdaterError(
      'CONFIG_NOT_FOUND',
      `No configuration at ${configPath}. Create one with "self-updater init" or pass --config.`
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new SelfUpdaterError('CONFIG_INVALID', `${configPath} is not valid JSON`, { cause: error });
  }
  const result = parseConfig(expandEnvironment(data, env));
  if (!result.ok) {
    throw new SelfUpdaterError('CONFIG_INVALID', `${configPath} has problems:\n${formatIssues(result.issues)}`);
  }
  return { config: resolvePaths(result.config, path.dirname(configPath)), path: configPath, migrated: result.migrated };
};

/** Writes JSON atomically: a crash leaves either the old or the new file, never half of one. */
export const writeJsonFile = async (file: string, value: unknown, mode = 0o600): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
  await rename(temporary, file);
};
