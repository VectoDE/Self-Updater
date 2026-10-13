// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

// "@vectode/self-updater/config": the configuration format and its checks without any Node.js API, for browsers,
// editors and tools that generate configuration files.
export * from './config/schema.js';
export { compareSemVer, newestTag, parseSemVer, type SemVer, tagMatcher } from './semver.js';
