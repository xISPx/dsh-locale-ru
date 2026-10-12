/**
 * Offline self-test of the built client bundle.
 *
 * Loads `lib/client.js` with a stub `window.__ModuleLoader__`, calls the factory
 * the way the DSH loader does, applies the plugin against a fake `ctx`, and then
 * checks what the bundle actually registered. This catches a broken module shape,
 * a missing export, an empty dictionary, or a language definition without a
 * fallback — without opening a browser.
 *
 * Usage: node tools/selftest.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const source = readFileSync(join(here, 'lib', 'client.js'), 'utf8');

const problems = [];
const check = (ok, message) => { if (!ok) problems.push(message); return ok; };

// The bundle patch addresses this package by name, so a rename that forgets the
// patch leaves a row the loader cannot resolve and the pack silently disappears.
const patch = readFileSync(join(here, 'cordis.patch.yml'), 'utf8');
const rowNames = [...patch.matchAll(/^\s*name:\s*'?([^'\s#]+)'?/gm)].map((m) => m[1]);
check(
  rowNames.includes(pkg.name),
  `cordis.patch.yml не объявляет строку с именем пакета "${pkg.name}" (найдено: ${rowNames.join(', ') || '—'})`,
);

// --- load the module the way the browser loader does ------------------------
let definition = null;
globalThis.window = {
  __ModuleLoader__: {
    load(def) { definition = def; },
  },
};

try {
  // eslint-disable-next-line no-new-func
  new Function(source)();
} catch (error) {
  console.error(`lib/client.js не выполняется: ${error.message}`);
  process.exit(1);
}

check(definition !== null, 'модуль не вызвал window.__ModuleLoader__.load');
if (definition) {
  check(definition.id === pkg.name, `id модуля "${definition.id}" не совпадает с именем пакета "${pkg.name}"`);
  check(typeof definition.factory === 'function', 'у загрузки нет factory');
}

// --- run the plugin against a fake client context ---------------------------
const languages = [];
const dicts = {};
let effects = 0;
const ctx = {
  effect(fn) { effects++; return fn(); },
  locale: {
    addLanguage(input) { languages.push(input); return () => {}; },
    register(ns, id, dict) { dicts[ns] = { id, dict }; return () => {}; },
  },
};

const exported = definition.factory(() => { throw new Error('модуль не должен ничего требовать'); });
check(typeof exported.apply === 'function', 'нет экспорта apply');
check(Array.isArray(exported.inject) && exported.inject.includes('locale'), 'export.inject не запрашивает сервис locale');

exported.apply(ctx);

// --- what did it register? --------------------------------------------------
check(languages.length === 1, `addLanguage вызван ${languages.length} раз(а), ожидался 1`);
const lang = languages[0] ?? {};
check(lang.id === 'ru', `идентификатор языка "${lang.id}" вместо "ru"`);
check(typeof lang.label === 'string' && lang.label.trim() !== '', 'у языка нет подписи');
check(lang.fallback === 'en', `fallback "${lang.fallback}" вместо "en"`);

const ru = JSON.parse(readFileSync(join(here, 'locales', 'ru.json'), 'utf8'));
const registered = Object.keys(dicts);
const declared = Object.keys(ru);

for (const ns of declared) check(registered.includes(ns), `словарь "${ns}" не зарегистрирован`);
for (const ns of registered) check(declared.includes(ns), `зарегистрирован лишний словарь "${ns}"`);
for (const [ns, { id, dict }] of Object.entries(dicts)) {
  check(id === 'ru', `словарь "${ns}" зарегистрирован под языком "${id}"`);
  check(Object.keys(dict).length === Object.keys(ru[ns] ?? {}).length, `словарь "${ns}": ключей ${Object.keys(dict).length}, в locales/ru.json ${Object.keys(ru[ns] ?? {}).length}`);
}

const keys = Object.values(dicts).reduce((a, d) => a + Object.keys(d.dict).length, 0);
const chars = Object.values(dicts).reduce((a, d) => a + Object.values(d.dict).reduce((x, s) => x + s.length, 0), 0);

console.log(`пакет            : ${pkg.name}`);
console.log(`язык             : ${lang.label} (id=${lang.id}, fallback=${lang.fallback})`);
console.log(`эффектов         : ${effects}`);
console.log(`словарей         : ${registered.length}`);
console.log(`строк перевода   : ${keys}  (~${chars} символов)`);

if (problems.length) {
  console.error(`\nПРОБЛЕМЫ (${problems.length}):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('\nOK: бандл собран корректно.');
