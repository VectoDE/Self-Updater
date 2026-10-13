// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

/** Stable error codes, so scripts and the CLI can react to a failure without parsing messages. */
export type ErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'CONFIG_ENV_MISSING'
  | 'WORKSPACE_NOT_EMPTY'
  | 'LOCKED'
  | 'GIT_FAILED'
  | 'TARGET_NOT_FOUND'
  | 'SIGNATURE_INVALID'
  | 'COMMAND_FAILED'
  | 'HEALTH_CHECK_FAILED'
  | 'NO_PREVIOUS_COMMIT';

export class SelfUpdaterError extends Error {
  override readonly name = 'SelfUpdaterError';

  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
  }
}

export const isSelfUpdaterError = (error: unknown, code?: ErrorCode): error is SelfUpdaterError =>
  error instanceof SelfUpdaterError && (code === undefined || error.code === code);

/** The message of anything that was thrown, for logs. */
export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
