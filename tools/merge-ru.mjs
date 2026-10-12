/**
 * Merge `work/ru/*.json` into `locales/ru.json` (the file build.mjs reads).
 *
 * Existing entries are kept unless a work file overrides them, so the merge can
 * be re-run after each translation batch.
 *
 * Usage: node tools/merge-ru.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const merged = existsSync(join(here, 'locales', 'ru.json'))
  ? JSON.parse(readFileSync(join(here, 'locales', 'ru.json'), 'utf8'))
  : {};

const workDir = join(here, 'work', 'ru');
let added = 0, updated = 0;
if (existsSync(workDir)) {
  for (const f of readdirSync(workDir).filter((f) => f.endsWith('.json')).sort()) {
    const ns = f.replace(/\.json$/, '');
    const dict = JSON.parse(readFileSync(join(workDir, f), 'utf8'));
    if (merged[ns]) updated++; else added++;
    merged[ns] = { ...(merged[ns] ?? {}), ...dict };
  }
}

const sorted = Object.fromEntries(Object.keys(merged).sort().map((ns) => [
  ns,
  Object.fromEntries(Object.keys(merged[ns]).sort().map((k) => [k, merged[ns][k]])),
]));
mkdirSync(join(here, 'locales'), { recursive: true });
writeFileSync(join(here, 'locales', 'ru.json'), JSON.stringify(sorted, null, 2) + '\n', 'utf8');

const keys = Object.values(sorted).reduce((a, d) => a + Object.keys(d).length, 0);
console.log(`locales/ru.json: ${Object.keys(sorted).length} пространств имён, ${keys} строк (новых: ${added}, обновлено: ${updated})`);
