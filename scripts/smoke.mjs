// SPDX-FileCopyrightText: 2025 Vecto <https://github.com/VectoDE>
//
// SPDX-License-Identifier: Apache-2.0

// Runs the built configuration entry (dist/config.mjs), which must work without Node-only APIs. CI runs it on Node,
// Deno and Bun: node scripts/smoke.mjs | deno run --allow-read=examples scripts/smoke.mjs | bun scripts/smoke.mjs
import { readFileSync } from 'node:fs';
import { migrateConfig, newestTag, parseConfig, parseConfigSet } from '../dist/config.mjs';

const check = (label, condition) => {
  if (!condition) {
    throw new Error(`Smoke test failed: ${label}`);
  }
  console.log(`ok  ${label}`);
};

const minimal = { repo: { url: 'https://github.com/acme/shop.git' }, workspace: { path: '/srv/shop' } };
const parsed = parseConfig({ ...minimal, service: { type: 'pm2', name: 'shop' } });
check('minimal configuration', parsed.ok && parsed.config.repo.branch === 'main' && parsed.config.rollback.enabled);

const broken = parseConfig({ ...minimal, service: { type: 'pm2' } });
check('missing service name is reported', !broken.ok && broken.issues[0]?.path === 'service.name');

const legacy = migrateConfig({
  repoUrl: 'https://github.com/acme/shop.git',
  localPath: '/srv/shop',
  serviceType: 'pm2',
  serviceName: 'shop',
});
check('1.x configuration converts', legacy.migrated && parseConfig(legacy.raw).ok);

check(
  'newest release tag',
  newestTag(['v1.9.0', 'v1.10.0', 'v2.0.0-rc.1'], { pattern: 'v*', prerelease: false }) === 'v1.10.0'
);

// The example files use ${NAME} placeholders that the server fills in from its environment.
for (const name of ['pm2', 'compose', 'systemd-tags']) {
  const source = readFileSync(new URL(`../examples/${name}.json`, import.meta.url), 'utf8')
    .replaceAll(/\$\{[A-Z_]+_URL\}/g, 'https://example.com/hook')
    .replaceAll(/\$\{[A-Z_]+\}/g, 'x'.repeat(32));
  check(`examples/${name}.json`, parseConfig(JSON.parse(source)).ok);
}
const fleet = readFileSync(new URL('../examples/workspaces.json', import.meta.url), 'utf8')
  .replaceAll(/\$\{[A-Z_]+_URL\}/g, 'https://example.com/hook')
  .replaceAll(/\$\{[A-Z_]+\}/g, 'x'.repeat(32));
check('examples/workspaces.json', parseConfigSet(JSON.parse(fleet)).ok);
