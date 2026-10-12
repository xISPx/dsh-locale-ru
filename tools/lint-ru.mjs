/**
 * Style and terminology lint for the Russian dictionaries.
 *
 * check-ru.mjs guards structure (keys, placeholders, whitespace). This one guards
 * consistency of language: the glossary in TRANSLATION.md is a single decision,
 * but translations arrive in batches, so this catches a batch that drifted to a
 * synonym or slipped into officialese.
 *
 * Usage:
 *   node tools/lint-ru.mjs                 # locales/ru.json (the assembled catalog)
 *   node tools/lint-ru.mjs work/ru         # per-namespace staging files
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(dirname(fileURLToPath(import.meta.url)));

/** [что искать, почему это замечание] */
const RULES = [
  ['сеанс', 'везде «сессия»'],
  ['подагент', 'везде «субагент»'],
  ['рабочее пространство', 'везде «рабочая область»'],
  ['поставщик', 'везде «провайдер»'],
  ['осуществля', 'канцелярит'],
  ['производится', 'канцелярит'],
  ['является', 'канцелярит: «не является X» → «не X»'],
  ['данный ', 'канцелярит'],
  ['в целях', 'канцелярит'],
  ['Вы ', 'обращение с заглавной буквы'],
  ['...', 'многоточие — символом «…»'],
  ['\u00a0', 'неразрывный пробел: только осознанно'],
  ['\u200b', 'невидимый символ'],
];

/** Собирает пары «пространство имён → словарь» из файла или каталога. */
function load(target) {
  if (statSync(target).isFile()) {
    const merged = JSON.parse(readFileSync(target, 'utf8'));
    return Object.entries(merged).map(([ns, dict]) => ({ ns, dict }));
  }
  return readdirSync(target)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ ns: f.replace(/\.json$/, ''), dict: JSON.parse(readFileSync(join(target, f), 'utf8')) }));
}

const target = process.argv[2] ?? join(here, 'locales', 'ru.json');
if (!existsSync(target)) { console.error(`нет файла или каталога: ${target}`); process.exit(2); }

const found = new Map();
let total = 0;

for (const { ns, dict } of load(target)) {
  for (const [key, value] of Object.entries(dict)) {
    total++;
    for (const [needle, why] of RULES) {
      // Осознанное исключение: разделитель групп разрядов в русском — неразрывный
      // пробел («1 000»), иначе число переносится по строке.
      if (needle === '\u00a0' && /groupSeparator/.test(key)) continue;
      // «Вы» с заглавной — замечание только внутри фразы: в начале строки это норма.
      if (needle === 'Вы ' && value.startsWith('Вы ')) continue;
      if (!value.includes(needle)) continue;
      if (!found.has(needle)) found.set(needle, { why, items: [] });
      found.get(needle).items.push(`[${ns}] ${key} = ${value.length > 100 ? value.slice(0, 100) + '…' : value}`);
    }
  }
}

console.log(`проверено строк: ${total}`);
let flagged = 0;
for (const [needle, { why, items }] of found) {
  flagged += items.length;
  console.log(`\n«${needle}» — ${why}. Совпадений: ${items.length}`);
  for (const item of items.slice(0, 6)) console.log('   ' + item);
  if (items.length > 6) console.log(`   … и ещё ${items.length - 6}`);
}
if (!flagged) {
  console.log('\nOK: терминология и стиль единообразны.');
} else {
  console.log(`\nВсего совпадений: ${flagged}. Каждое нужно посмотреть глазами: правило может сработать на верной фразе.`);
}
