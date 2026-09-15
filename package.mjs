import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const archive = `wedelia-notes-${manifest.version}.zip`;
const archivePath = resolve('release', archive);

await mkdir('release', { recursive: true });
await rm(archivePath, { force: true });

// Put a ready-to-copy `wedelia-notes/` folder at the archive root. A user can
// now extract the zip straight into `<vault>/.obsidian/plugins/` instead of
// having to create and name a hidden plugin directory by hand.
const stage = await mkdtemp(join(tmpdir(), 'wedelia-notes-package-'));
const pluginDir = join(stage, 'wedelia-notes');
await mkdir(pluginDir);
const packagedFiles = ['main.js', 'manifest.json', 'package.json'];
for (const file of packagedFiles) {
  await copyFile(join('dist', file), join(pluginDir, file));
}

// Stable timestamps plus `zip -X` keep the committed mobile asset reproducible.
// Re-running `npm run package` from the same source must not create a new hash.
const archiveTime = new Date('2000-01-01T00:00:00Z');
for (const file of packagedFiles) {
  await utimes(join(pluginDir, file), archiveTime, archiveTime);
}
await utimes(pluginDir, archiveTime, archiveTime);

try {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'zip',
      [
        '-X',
        '-q',
        archivePath,
        'wedelia-notes/',
        ...packagedFiles.map((file) => `wedelia-notes/${file}`),
      ],
      { cwd: stage, stdio: 'inherit' },
    );
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`zip exited with code ${code ?? 'unknown'}`));
    });
  });
} finally {
  await rm(stage, { recursive: true, force: true });
}

console.log(`Packaged release/${archive}`);
