import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { digest, option, validateTemplates } from './template-files.mjs';
import { writeZip } from './zip.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');
const manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'));
await validateTemplates(join(dist, 'templates'));
const output = resolve(option('--output', join(root, 'releases')));
await mkdir(output, { recursive: true });
const archive = join(output, `${manifest.id}-${manifest.version}.zip`);
const stage = await mkdtemp(join(output, '.package-'));
try {
  const catalog = JSON.parse(await readFile(join(dist, 'templates/catalog.json'), 'utf8'));
  const names = ['main.js', 'manifest.json', 'styles.css', 'templates/catalog.json', ...catalog.files.map(file => `templates/${file.path}`)];
  try { await readFile(join(dist, 'LICENSE')); names.push('LICENSE'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pending = join(stage, 'release.zip');
  await writeZip(pending, names.map(name => ({ name: `${manifest.id}/${name}`, path: join(dist, name) })));
  await rename(pending, archive);
  const sha256 = digest(await readFile(archive));
  await writeFile(join(output, 'SHA256SUMS'), `${sha256}  ${manifest.id}-${manifest.version}.zip\n`);
  await cp(join(dist, 'manifest.json'), join(output, 'manifest.json'));
  console.log(JSON.stringify({ archive, sha256 }, null, 2));
} finally { await rm(stage, { recursive: true, force: true }); }
