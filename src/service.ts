import process from 'node:process';
import type { ServiceConfig } from './config/schema.js';

/** A program with its arguments (run without a shell), or a command line for the system shell. */
export type Command = string | [string, ...string[]];

const builtIn = (service: ServiceConfig): [string, ...string[]] | undefined => {
  switch (service.type) {
    case 'pm2':
      // reload restarts the processes one after the other, so a cluster keeps serving.
      return ['pm2', 'reload', service.name ?? '', '--update-env'];
    case 'docker':
      return ['docker', 'restart', service.name ?? ''];
    case 'compose':
      // "up -d --build" picks up a changed image or Dockerfile; a plain restart would keep the old container.
      return [
        'docker',
        'compose',
        ...(service.composeFile ? ['-f', service.composeFile] : []),
        'up',
        '--detach',
        '--build',
        '--remove-orphans',
        service.composeService ?? service.name ?? '',
      ];
    case 'systemd':
      return ['systemctl', 'restart', service.name ?? ''];
    default:
      return undefined;
  }
};

/**
 * The restart command for a service: an argument list for the built-in types (no shell, names cannot inject
 * anything), the operator's own command string for "command" or when service.command is set, or undefined for
 * "none".
 */
export const restartCommand = (
  service: ServiceConfig,
  platform: NodeJS.Platform = process.platform
): Command | undefined => {
  let command: Command | undefined = service.command;
  const args = command === undefined ? builtIn(service) : undefined;
  if (args) {
    const full: [string, ...string[]] = service.sudo ? ['sudo', '-n', ...args] : args;
    // pm2 and docker are .cmd shims on Windows, which Node only starts through a shell. Names are restricted to
    // letters, digits and . _ - @ : by the configuration check, so joining them is safe.
    command = platform === 'win32' ? full.join(' ') : full;
  }
  return command;
};
