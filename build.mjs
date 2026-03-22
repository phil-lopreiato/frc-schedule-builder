/**
 * Build script: inlines local ES modules into index.html, writing dist/index.html.
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

function inlineModule(source, moduleFile, importRe) {
  let mod = read(moduleFile);
  mod = mod.replace(/^export ((?:async )?(?:function|const|let|var))/gm, '$1');
  if (!importRe.test(source)) {
    console.error(`ERROR: could not find ${moduleFile} import in index.html`);
    process.exit(1);
  }
  return source.replace(importRe, mod + '\n');
}

html = inlineModule(html, 'agenda-parser.mjs', /^import \{[^}]+\} from '\.\/agenda-parser\.mjs';\n/m);
html = inlineModule(html, 'schedule-layout.mjs', /^import \{[^}]+\} from '\.\/schedule-layout\.mjs';\n/m);

mkdirSync(join(__dir, 'dist'), { recursive: true });
writeFileSync(join(__dir, 'dist', 'index.html'), html);
console.log('✓  Built dist/index.html');
