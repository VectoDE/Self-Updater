// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { rename, rm, rmdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { SelfUpdaterError } from './errors.js';

export type SlotName = 'blue' | 'green';

/**
 * The two checkouts of a blue-green workspace and the link between them: path.blue and path.green sit next to
 * workspace.path, which is a symlink (a junction on Windows) to the live one.
 */
export class Slots {
  constructor(
    readonly link: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  dir(slot: SlotName): string {
    return `${this.link}.${slot}`;
  }

  /** The slot the link points to, or undefined before the first deployment. */
  active(): SlotName | undefined {
    let stats;
    try {
      stats = lstatSync(this.link);
    } catch {
      return undefined;
    }
    if (!stats.isSymbolicLink()) {
      // An empty directory is what "init" or a package may leave; anything else is a checkout we must not touch.
      if (stats.isDirectory() && readdirSync(this.link).length === 0) {
        return undefined;
      }
      throw new SelfUpdaterError(
        'WORKSPACE_NOT_LINK',
        `${this.link} is a directory, but the blue-green strategy manages it as a link. Move the checkout to ` +
          `${this.dir('blue')} and remove ${this.link}, or use the in-place strategy.`
      );
    }
    const target = realpathSync(this.link);
    for (const slot of ['blue', 'green'] as const) {
      if (existsSync(this.dir(slot)) && realpathSync(this.dir(slot)) === target) {
        return slot;
      }
    }
    throw new SelfUpdaterError('WORKSPACE_NOT_LINK', `${this.link} points to ${target}, which is neither slot.`);
  }

  /** The slot that is not live; blue before the first deployment. */
  idle(): SlotName {
    return this.active() === 'blue' ? 'green' : 'blue';
  }

  /**
   * Points the link at the slot. On Linux and macOS a new link replaces the old one in a single rename, so the path
   * never goes missing. Windows cannot rename over a junction: there the old one is removed first.
   */
  async switchTo(slot: SlotName): Promise<void> {
    const target = path.resolve(this.dir(slot));
    const next = `${this.link}.next`;
    await rm(next, { force: true });
    const current = this.kind();
    if (current === 'directory') {
      // The empty directory active() accepted before the first deployment.
      await rmdir(this.link);
    }
    if (this.platform === 'win32') {
      if (current === 'link') {
        // Removes the junction only; the slot it pointed to stays as it is.
        await rm(this.link, { force: true });
      }
      await symlink(target, this.link, 'junction');
      return;
    }
    await symlink(target, next, 'dir');
    await rename(next, this.link);
  }

  private kind(): 'link' | 'directory' | undefined {
    try {
      const stats = lstatSync(this.link);
      if (stats.isSymbolicLink()) {
        return 'link';
      }
      return stats.isDirectory() ? 'directory' : undefined;
    } catch {
      return undefined;
    }
  }
}
