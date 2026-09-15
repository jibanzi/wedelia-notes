import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';

/**
 * Bundles main.ts into the single main.js Obsidian loads.
 *
 * `obsidian` is external because the app provides it at runtime; bundling it
 * would ship a second copy of an API that must be the host's. The output is
 * CommonJS because that is what Obsidian's plugin loader requires — an ESM
 * bundle loads as an empty module with no error, which looks like a plugin
 * that installed fine and does nothing.
 *
 * Everything under src/ is bundled in, so the tested core and the shipped
 * artefact cannot drift.
 */
const out = 'dist';
await mkdir(out, { recursive: true });

await build({
  entryPoints: ['main.ts'],
  outfile: `${out}/main.js`,
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', 'electron'],
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Obsidian reads the manifest from the plugin folder, not from the bundle.
await copyFile('manifest.json', `${out}/manifest.json`);

// Obsidian evaluates main.js as CommonJS regardless, but this package is
// "type": "module", so without this Node reads the .js extension as ESM and
// the bundle cannot even be loaded to check. An artefact my own smoke test
// cannot open is not one worth shipping.
await writeFile(`${out}/package.json`, `${JSON.stringify({ type: 'commonjs' }, null, 2)}\n`);

console.log(`\nInstall by copying ${out}/ into <vault>/.obsidian/plugins/wedelia-notes/`);
