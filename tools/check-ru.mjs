/**
 * Validate Russian dictionaries against their English source.
 *
 * Checks, per namespace: the key set is identical, no value is empty, every
 * `{placeholder}` set matches the source, and leading/trailing whitespace is
 * preserved (these strings are concatenated with their neighbours).
 *
 * Usage:
 *   node tools/check-ru.mjs work/ru [ns ...]   # files written by a translator
 *   node tools/check-ru.mjs --merged           # the merged locales/ru.json
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const enDir = join(here, 'locales', 'en');
const args = process.argv.slice(2);

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const edges = (s) => `${s.match(/^\s*/)[0].length}:${s.match(/\s*$/)[0].length}`;
/** Разделитель: только пробелы и знаки препинания, без букв и цифр. */
const isSeparator = (s) => !/[\p{L}\p{N}]/u.test(s);

/** @returns {{ns: string, dict: object}[]} */
function loadTargets() {
  if (args[0] === '--merged') {
    const merged = JSON.parse(readFileSync(join(here, 'locales', 'ru.json'), 'utf8'));
    return Object.entries(merged).map(([ns, dict]) => ({ ns, dict }));
  }
  const dir = args[0];
  if (!dir) { console.error('usage: node tools/check-ru.mjs <dir> [ns ...] | --merged'); process.exit(2); }
  const only = args.slice(1);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && (!only.length || only.includes(f.replace(/\.json$/, ''))))
    .map((f) => ({ ns: f.replace(/\.json$/, ''), dict: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
}

const problems = [];
const summary = [];
for (const { ns, dict } of loadTargets()) {
  const enPath = join(enDir, `${ns}.json`);
  if (!existsSync(enPath)) { problems.push(`[${ns}] нет английского источника`); continue; }
  const en = JSON.parse(readFileSync(enPath, 'utf8'));
  let ok = 0;
  for (const key of Object.keys(en)) {
    const ru = dict[key];
    if (ru === undefined) { problems.push(`[${ns}] ${key}: пропущен`); continue; }
    if (typeof ru !== 'string') { problems.push(`[${ns}] ${key}: не строка`); continue; }
    // Whitespace-only values are separators (a space, ", "): they must match the
    // source exactly, character for character — nothing to translate.
    if (en[key].trim() === '') {
      if (ru !== en[key]) {
        const code = (s) => [...s].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
        problems.push(`[${ns}] ${key}: разделитель изменён (${code(ru)} вместо ${code(en[key])})`);
        continue;
      }
      ok++;
      continue;
    }
    // Other punctuation-only values are separators too, but their content is a
    // translation decision: the Russian thousands separator is a space, not a
    // comma. Only require that the separator exists.
    if (isSeparator(en[key])) {
      if (ru.length === 0) { problems.push(`[${ns}] ${key}: разделитель потерян`); continue; }
      ok++;
      continue;
    }
    if (!ru.trim()) { problems.push(`[${ns}] ${key}: пустое значение`); continue; }
    if (placeholders(ru) !== placeholders(en[key])) {
      problems.push(`[${ns}] ${key}: плейсхолдеры {${placeholders(en[key])}} -> {${placeholders(ru)}}`);
      continue;
    }
    if (edges(ru) !== edges(en[key]) && !isSeparator(en[key])) {
      problems.push(`[${ns}] ${key}: пробелы по краям ${JSON.stringify(en[key].slice(0, 12))}… -> ${JSON.stringify(ru.slice(0, 12))}…`);
      continue;
    }
    ok++;
  }
  for (const key of Object.keys(dict)) if (!(key in en)) problems.push(`[${ns}] ${key}: лишний ключ`);
  summary.push(`${ns.padEnd(30)} ${String(ok).padStart(4)}/${String(Object.keys(en).length).padEnd(4)}`);
}

console.log(summary.join('\n'));
if (problems.length) {
  console.log(`\nПРОБЛЕМЫ (${problems.length}):`);
  for (const p of problems.slice(0, 40)) console.log('  ' + p);
  if (problems.length > 40) console.log(`  … и ещё ${problems.length - 40}`);
  process.exit(1);
}
console.log(`\nOK: ${summary.length} пространств имён, замечаний нет.`);
