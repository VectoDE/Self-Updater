// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { LogFormat, LogLevel } from './config/schema.js';

const WEIGHT: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  fields: LogFields;
}

export interface LoggerOptions {
  level?: LogLevel;
  format?: LogFormat;
  /** Append every line to this file as well. */
  file?: string;
  /** Values that must never appear in the output (tokens, secrets, webhook URLs). */
  secrets?: readonly (string | undefined)[];
  /** Where lines go; defaults to stderr for warnings and errors, stdout for the rest. */
  write?: (line: string, level: LogLevel) => void;
  /** Fields added to every line, e.g. the workspace. */
  fields?: LogFields;
}

const defaultWrite = (line: string, level: LogLevel) => {
  if (level === 'error' || level === 'warn') {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
};

const text = (value: unknown): string => {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === 'string') {
    return value;
  }
  // JSON.stringify returns undefined for these, despite its type.
  if (typeof value === 'function' || typeof value === 'symbol' || value === undefined) {
    return String(value);
  }
  return JSON.stringify(value);
};

const hide = (value: string, secrets: readonly string[]): string =>
  secrets.reduce((result, secret) => result.replaceAll(secret, '***'), value);

export class Logger {
  private readonly level: LogLevel;
  private readonly format: LogFormat;
  private readonly file: string | undefined;
  private readonly write: (line: string, level: LogLevel) => void;
  private readonly secrets: string[];
  private readonly jsonSecrets: string[];
  private readonly fields: LogFields;

  constructor(private readonly options: LoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.format = options.format ?? 'text';
    this.write = options.write ?? defaultWrite;
    // Longest first, so a secret that contains another is hidden as a whole.
    this.secrets = (options.secrets ?? [])
      .filter((secret): secret is string => typeof secret === 'string' && secret.length >= 4)
      .sort((a, b) => b.length - a.length);
    // In a JSON line a secret with quotes, backslashes or control characters appears in its escaped form.
    this.jsonSecrets = this.secrets.map((secret) => JSON.stringify(secret).slice(1, -1));
    this.file = options.file;
    this.fields = options.fields ?? {};
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
    }
  }

  /** A logger that writes to the same place and adds the fields to every line. */
  child(fields: LogFields): Logger {
    return new Logger({ ...this.options, fields: { ...this.fields, ...fields } });
  }

  /** Hides every known secret in a string. */
  redact(value: string): string {
    return hide(value, this.secrets);
  }

  enabled(level: LogLevel): boolean {
    return WEIGHT[level] <= WEIGHT[this.level];
  }

  log(level: LogLevel, message: string, fields: LogFields = {}): void {
    if (!this.enabled(level)) {
      return;
    }
    const time = new Date().toISOString();
    const entries = Object.entries({ ...this.fields, ...fields }).filter(([, value]) => value !== undefined);
    let line: string;
    if (this.format === 'json') {
      const record = Object.fromEntries(
        entries.map(([key, value]) => [key, value instanceof Error ? value.message : value])
      );
      line = JSON.stringify({ time, level, message, ...record });
    } else {
      const details = entries.map(([key, value]) => `${key}=${text(value)}`).join(' ');
      const suffix = details ? ` ${details}` : '';
      line = `${time} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
    }
    // Command output may span lines; one record stays one line so log shippers do not split it.
    line = hide(line, this.format === 'json' ? this.jsonSecrets : this.secrets).replaceAll(
      /\r?\n/g,
      this.format === 'json' ? String.raw`\n` : ' | '
    );
    this.write(line, level);
    if (this.file) {
      appendFileSync(this.file, `${line}\n`);
    }
  }

  error(message: string, fields?: LogFields): void {
    this.log('error', message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.log('warn', message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.log('info', message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.log('debug', message, fields);
  }
}

/** A logger that drops everything, for library use without output. */
export const silentLogger = new Logger({ level: 'error', write: () => undefined });
