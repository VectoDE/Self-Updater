import { readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import process from 'node:process';
import { SelfUpdaterError } from './errors.js';

interface LockOwner {
  pid: number;
  host: string;
  since: string;
}

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const readOwner = async (file: string): Promise<LockOwner | undefined> => {
  try {
    const owner = JSON.parse(await readFile(file, 'utf8')) as Partial<LockOwner>;
    return typeof owner.pid === 'number' && typeof owner.host === 'string' && typeof owner.since === 'string'
      ? (owner as LockOwner)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Takes an exclusive lock file so two updaters never deploy into the same workspace at once. A lock left behind by
 * a process that no longer runs on this host, or one older than staleAfterSeconds, is taken over.
 */
export const acquireLock = async (file: string, staleAfterSeconds = 6 * 60 * 60): Promise<() => Promise<void>> => {
  const owner: LockOwner = { pid: process.pid, host: os.hostname(), since: new Date().toISOString() };
  const release = async () => {
    const current = await readOwner(file);
    if (current?.pid === owner.pid && current.since === owner.since) {
      await rm(file, { force: true });
    }
  };
  // An abandoned lock is removed once and the lock taken again; a second conflict means someone else was faster.
  const take = async (mayTakeOver: boolean): Promise<() => Promise<void>> => {
    try {
      await writeFile(file, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error;
      }
    }
    const holder = await readOwner(file);
    const age = holder ? (Date.now() - Date.parse(holder.since)) / 1000 : Number.POSITIVE_INFINITY;
    const abandoned = !holder || age > staleAfterSeconds || (holder.host === owner.host && !isRunning(holder.pid));
    if (!abandoned || !mayTakeOver) {
      const pid = holder?.pid ?? 'unknown';
      const host = holder?.host ?? 'unknown host';
      const since = holder?.since ?? 'unknown';
      throw new SelfUpdaterError('LOCKED', `Another update is running (pid ${pid} on ${host} since ${since}).`);
    }
    await rm(file, { force: true });
    return take(false);
  };
  return take(true);
};
