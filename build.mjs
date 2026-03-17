/**
 * Build script: inlines agenda-parser.mjs into index.html, writing dist/index.html.
 *
 * The resulting dist/index.html has no ES-module imports so it works when opened
 * directly from the filesystem (file://) as well as from any HTTP server or
 * GitHub Pages.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const read  = f => readFileSync(join(__dir, f), 'utf8');

// Read sources
let html = read('index.html');
let mod  = read('agenda-parser.mjs');

// Strip "export " from top-level declarations so they become plain local functions
mod = mod.replace(/^export ((?:async )?(?:function|const|let|var))/gm, '$1');

// Replace the single import line with the inlined module content
const importRe = /^import \{[^}]+\} from '\.\/agenda-parser\.mjs';\n/m;
if (!importRe.test(html)) {
  console.error('ERROR: could not find agenda-parser import in index.html');
  process.exit(1);
}
html = html.replace(importRe, mod + '\n');

mkdirSync(join(__dir, 'dist'), { recursive: true });
writeFileSync(join(__dir, 'dist', 'index.html'), html);
console.log('✓  Built dist/index.html');
