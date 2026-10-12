/**
 * Extract the English dictionaries shipped inside the DSH client bundles.
 *
 * Input : the extracted `@deepseek-ai/*` client bundles (see README, "Rebuilding
 *         after a DSH update").
 * Output: `locales/en/<namespace>.json` — the English source catalog this pack
 *         translates, plus a report of anything the parser did not understand.
 *
 * Namespaces come from the `locale.register(...)` calls themselves, so a
 * namespace is never guessed from a package name.
 *
 * Usage: node tools/extract-english.mjs <dir-with-client.js-files> [--write]
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.argv[2];
const write = process.argv.includes('--write');
if (!root || !existsSync(root)) {
  console.error('usage: node tools/extract-english.mjs <dir-with-client.js-files> [--write]');
  process.exit(2);
}

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const hasCJK = (s) => CJK.test(s);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name === 'client.js') acc.push(p);
  }
  return acc;
}

/** Capture a balanced `{}`/`[]`/`()` region starting at the opening char. */
function balanced(src, start) {
  const open = src[start];
  const close = { '{': '}', '[': ']', '(': ')' }[open];
  let depth = 0, inStr = null, esc = false, inLine = false, inBlock = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i++; } continue; }
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

/** Raw token of a quoted string starting at `start`, or null. */
function stringToken(src, start) {
  const quote = src[start];
  if (quote !== '"' && quote !== "'") return null;
  let esc = false;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === quote) return src.slice(start, i + 1);
    if (c === '\n') return null;
  }
  return null;
}

/** Decode a `"…"` or `'…'` token to its string value. */
function decodeString(token) {
  if (token === null) return null;
  if (token[0] === '"') { try { return JSON.parse(token); } catch { return null; } }
  const body = token.slice(1, -1).replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  return body;
}

/** Split text on top-level commas (ignores nesting and string contents). */
function splitTop(body) {
  const parts = [];
  let depth = 0, inStr = null, esc = false, cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inStr) {
      cur += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
    if (c === '{' || c === '[' || c === '(') depth++;
    if (c === '}' || c === ']' || c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** Top-level `key: value` pairs of an object literal, as raw token text. */
function topLevelProps(literal) {
  if (!literal || literal[0] !== '{') return null;
  const parts = splitTop(literal.slice(1, -1));
  const out = [];
  for (const part of parts) {
    // Shorthand property: `{ zh, en }` — the identifier is both key and value.
    const shorthand = part.match(/^\s*([A-Za-z_$][\w$]*)\s*$/);
    if (shorthand) { out.push([shorthand[1], shorthand[1]]); continue; }
    const m = part.match(/^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+?)\s*$/);
    if (!m) continue;
    const key = m[1] !== undefined ? decodeString(`"${m[1]}"`) : m[2] !== undefined ? m[2] : m[3];
    out.push([key, m[4]]);
  }
  return out;
}

/** Flat string map from an object literal. */
function objectEntries(literal) {
  const props = topLevelProps(literal);
  if (!props) return null;
  const entries = {};
  let count = 0;
  for (const [key, token] of props) {
    const value = token[0] === '"' || token[0] === "'" ? decodeString(stringToken(token, 0)) : null;
    if (value === null) continue;
    entries[key] = value;
    count++;
  }
  return count ? entries : null;
}

const namespaces = {};
const conflicts = [];
const unparsed = [];
const perFile = [];

for (const file of walk(root).sort()) {
  const src = readFileSync(file, 'utf8');
  const pkg = basename(dirname(dirname(file)));

  // Identifiers we may need to resolve register arguments through.
  const decls = {};
  const declRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let d;
  while ((d = declRe.exec(src))) {
    const name = d[1];
    const at = d.index + d[0].length;
    const c = src[at];
    if (c === '{' || c === '[') {
      const lit = balanced(src, at);
      if (lit) decls[name] = { kind: 'literal', text: lit };
    } else if (c === '"' || c === "'") {
      const tok = stringToken(src, at);
      const sv = decodeString(tok);
      if (sv !== null) decls[name] = { kind: 'string', value: sv };
    }
  }

  const literalOf = (token, kind) => {
    if (token[0] === '{') return token;
    const clean = token.replace(/^\(|\)$/g, '').trim();
    const decl = decls[clean];
    return decl && decl.kind === kind ? (kind === 'string' ? decl.value : decl.text) : null;
  };
  const resolveString = (token) => {
    if (token[0] === '"' || token[0] === "'") return decodeString(stringToken(token, 0));
    return literalOf(token, 'string');
  };
  const resolveDict = (token) => {
    const lit = literalOf(token, 'literal');
    return lit ? objectEntries(lit) : null;
  };
  /** `{ zh: <dict>, en: <dict> }` — typed or per-locale form. */
  const resolvePropertyMap = (token) => {
    const lit = literalOf(token, 'literal');
    if (!lit) return null;
    const props = topLevelProps(lit);
    if (!props) return null;
    const out = {};
    for (const [key, value] of props) {
      const dict = resolveDict(value);
      if (dict) out[key] = dict;
    }
    return Object.keys(out).length ? out : null;
  };
  /**
   * `const dictionaries = [['zh', {…}], ['en', {…}]]` — the array-of-pairs shape
   * a register loop walks, as in the directory picker.
   */
  const resolvePairMap = (token) => {
    const clean = token.replace(/^\(|\)$/g, '').trim();
    const decl = decls[clean];
    if (!decl || decl.kind !== 'literal' || decl.text[0] !== '[') return null;
    const out = {};
    for (const element of splitTop(decl.text.slice(1, -1))) {
      const m = element.match(/^\s*\[\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*,\s*([\s\S]+?)\s*\]\s*$/);
      if (!m) continue;
      const id = decodeString(m[1] !== undefined ? `"${m[1]}"` : null) ?? m[2];
      const dict = resolveDict(m[3]);
      if (id && dict) out[id] = dict;
    }
    return Object.keys(out).length ? out : null;
  };

  const regRe = /\blocale\s*\.\s*register\s*\(/g;
  let r;
  let found = 0;
  while ((r = regRe.exec(src))) {
    const openParen = r.index + r[0].length - 1;
    const call = balanced(src, openParen);
    if (!call) continue;
    const args = [];
    {
      // split top-level commas of the argument list
      const body = call.slice(1, -1);
      let depth = 0, inStr = null, esc = false, cur = '';
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) {
          cur += c;
          if (esc) { esc = false; continue; }
          if (c === '\\') { esc = true; continue; }
          if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === '`') { inStr = c; cur += c; continue; }
        if (c === '{' || c === '[' || c === '(') depth++;
        if (c === '}' || c === ']' || c === ')') depth--;
        if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
        cur += c;
      }
      if (cur.trim()) args.push(cur.trim());
    }
    const ns = resolveString(args[0] ?? '');
    if (ns === null) { unparsed.push({ pkg, raw: (args[0] ?? '').slice(0, 40), why: 'namespace not resolvable' }); continue; }

    let dicts = null;
    if (args.length === 2) {
      dicts = resolvePropertyMap(args[1]);
      if (!dicts) { unparsed.push({ pkg, raw: ns, why: 'typed dictionary not resolvable' }); continue; }
    } else if (args.length >= 3) {
      const id = resolveString(args[1]);
      const dict = resolveDict(args[2]);
      if (id !== null && dict) dicts = { [id]: dict };
      else dicts = resolvePairMap(args[2]); // loop over an array of [id, dict] pairs
      if (!dicts) {
        // The loop variable hides the source; fall back to any array-of-pairs
        // declaration in the same file (there is exactly one shape like this).
        for (const name of Object.keys(decls)) {
          const pairs = resolvePairMap(name);
          if (pairs) { dicts = pairs; console.log(`note: ${pkg} [${ns}] dictionaries taken from array "${name}"`); break; }
        }
      }
      if (!dicts) { unparsed.push({ pkg, raw: ns, why: 'per-locale dictionary not resolvable' }); continue; }
    }
    if (!dicts) continue;

    found++;
    const slot = (namespaces[ns] ??= { en: {}, zh: {} });
    for (const [id, dict] of Object.entries(dicts)) {
      if (id === 'en') {
        for (const [k, v] of Object.entries(dict)) {
          if (slot.en[k] !== undefined && slot.en[k] !== v) conflicts.push({ ns, key: k, was: slot.en[k], now: v, pkg });
          slot.en[k] = v;
        }
      } else if (id === 'zh') {
        for (const [k, v] of Object.entries(dict)) {
          if (slot.zh[k] !== undefined && slot.zh[k] !== v) conflicts.push({ ns, key: k, was: slot.zh[k], now: v, pkg });
          slot.zh[k] = v;
        }
      } else {
        console.log(`note: non-en/zh dictionary id "${id}" in ${pkg} [${ns}]`);
      }
    }
  }
  perFile.push({ pkg, registrations: found });
}

const rows = Object.entries(namespaces)
  .map(([ns, v]) => ({ ns, en: Object.keys(v.en).length, zh: Object.keys(v.zh).length }))
  .sort((a, b) => b.en - a.en);
const totalEn = rows.reduce((a, r) => a + r.en, 0);

console.log(`files scanned      : ${perFile.length}`);
console.log(`namespaces found   : ${rows.length}`);
console.log(`English keys       : ${totalEn}`);
console.log(`files w/o register : ${perFile.filter((f) => !f.registrations).map((f) => f.pkg).join(', ') || '(none)'}`);
if (conflicts.length) {
  console.log(`\nkey conflicts : ${conflicts.length}`);
  for (const c of conflicts.slice(0, 10)) console.log(`  [${c.ns}] ${c.key}: "${c.was}" vs "${c.now}" (${c.pkg})`);
}
if (unparsed.length) {
  console.log(`\nunparsed registrations : ${unparsed.length}`);
  for (const u of unparsed.slice(0, 10)) console.log(`  ${u.pkg} [${u.raw}] — ${u.why}`);
}

if (write) {
  const dir = join(here, 'locales', 'en');
  mkdirSync(dir, { recursive: true });
  for (const [ns, v] of Object.entries(namespaces)) {
    const sorted = Object.fromEntries(Object.keys(v.en).sort().map((k) => [k, v.en[k]]));
    writeFileSync(join(dir, `${ns}.json`), JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  }
  writeFileSync(join(here, 'locales', 'zh-source.json'), JSON.stringify(
    Object.fromEntries(Object.entries(namespaces).map(([ns, v]) => [ns, v.zh])), null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${rows.length} file(s) to locales/en/`);
}
