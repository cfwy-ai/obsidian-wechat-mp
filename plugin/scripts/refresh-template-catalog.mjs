import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTemplateCatalog, resolveTemplatesRoot, validateTemplates } from './template-files.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const templatesRoot = resolveTemplatesRoot(root);
const previous = JSON.parse(await readFile(join(templatesRoot, 'catalog.json'), 'utf8'));
await writeFile(join(templatesRoot, 'catalog.json'), JSON.stringify(await createTemplateCatalog(templatesRoot, previous.themes), null, 2) + '\n');
console.log(JSON.stringify(await validateTemplates(templatesRoot), null, 2));
