// Bundles the configuration builder into site/dist. With --serve it rebuilds on change and serves on
// http://localhost:5173.
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = fileURLToPath(new URL('../site/', import.meta.url));
const outdir = `${root}dist`;
const serve = process.argv.includes('--serve');
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await Promise.all(['index.html', 'styles.css'].map((file) => copyFile(`${root}${file}`, `${outdir}/${file}`)));

const options = {
  entryPoints: [`${root}src/main.ts`],
  outfile: `${outdir}/main.js`,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: !serve,
  sourcemap: serve,
  legalComments: 'none',
  logLevel: 'info',
  define: { __VERSION__: JSON.stringify(version) },
};

if (serve) {
  const context = await esbuild.context(options);
  await context.watch();
  // HTML and CSS are copied once; restart after changing them.
  const { port } = await context.serve({ servedir: outdir, port: 5173, host: '127.0.0.1' });
  console.log(`Configuration builder on http://localhost:${port}`);
} else {
  await esbuild.build(options);
}
