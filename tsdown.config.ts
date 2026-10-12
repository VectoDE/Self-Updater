import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const { version } = JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig([
  {
    // Library: ESM and CommonJS with type declarations for both. "config" has no Node.js imports.
    entry: { index: 'src/index.ts', config: 'src/config.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node22',
    dts: true,
    sourcemap: true,
    // npm run build empties dist first; the two builds run in parallel and must not clean each other's output.
    clean: false,
    define: { __VERSION__: JSON.stringify(version) },
  },
  {
    // Command line: one ESM file for Node, version baked in.
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    dts: false,
    clean: false,
    define: { __VERSION__: JSON.stringify(version) },
  },
]);
