// Bundles the main process, the preload script and the renderer pages into dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const fromRoot = (...parts) => path.join(root, ...parts);

fs.rmSync(dist, { recursive: true, force: true });

const common = {
  bundle: true,
  logLevel: 'warning',
  legalComments: 'none',
};

await Promise.all([
  build({
    ...common,
    entryPoints: [fromRoot('src/main/main.ts')],
    outfile: path.join(dist, 'main/main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [fromRoot('src/preload/preload.ts')],
    outfile: path.join(dist, 'preload/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: [fromRoot('src/renderer/widget.ts'), fromRoot('src/renderer/settings.ts')],
    outdir: path.join(dist, 'renderer'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
  }),
]);

const rendererDir = fromRoot('src/renderer');
for (const file of fs.readdirSync(rendererDir)) {
  if (file.endsWith('.html') || file.endsWith('.css')) {
    fs.copyFileSync(path.join(rendererDir, file), path.join(dist, 'renderer', file));
  }
}
fs.cpSync(fromRoot('src/assets'), path.join(dist, 'assets'), { recursive: true });

console.log('Build finished: dist/');
