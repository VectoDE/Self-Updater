// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from 'node:fs';
import { writeJsonFile } from './config/load.js';

export type DeploymentOutcome = 'deployed' | 'failed' | 'rolled-back';

export interface DeploymentRecord {
  outcome: DeploymentOutcome;
  ref: string;
  commit: string;
  previousCommit?: string;
  error?: string;
  time: string;
}

/** What the updater remembers between runs, in updater.state.json next to the configuration. */
export interface UpdaterState {
  /** Commit that was deployed last and passed its checks. */
  lastCommit?: string;
  lastRef?: string;
  updatedAt?: string;
  /** Commit that failed and was rolled back; it is skipped until a newer one arrives or --force is used. */
  failedCommit?: string;
  history: DeploymentRecord[];
}

const HISTORY = 50;

export const readState = (file: string): UpdaterState => {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<UpdaterState>;
    return { ...data, history: Array.isArray(data.history) ? data.history.slice(0, HISTORY) : [] };
  } catch {
    return { history: [] };
  }
};

export const recordDeployment = (state: UpdaterState, record: DeploymentRecord): UpdaterState => {
  const next: UpdaterState = { ...state, history: [record, ...state.history].slice(0, HISTORY) };
  if (record.outcome === 'deployed') {
    next.lastCommit = record.commit;
    next.lastRef = record.ref;
    next.updatedAt = record.time;
    delete next.failedCommit;
  } else {
    next.failedCommit = record.commit;
  }
  return next;
};

export const writeState = (file: string, state: UpdaterState): Promise<void> => writeJsonFile(file, state);
