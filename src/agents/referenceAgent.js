import path from 'node:path';
import { grepPattern, grepWord } from '../git/index.js';

// Read-only. Answers "what else in the repo depends on what this conflict changes?"
// Deterministic and text based (git grep + light declaration parsing for JS/TS), so it
// has false positives and misses dynamic usage. The `finder` seam exists so an editor's
// "find all references" can replace grep later without touching the logic here.

const MAX_SYMBOLS_PER_HUNK = 8;
const MAX_FLAG_LOCATIONS = 2;
const MAX_PROMPT_REFS_PER_SYMBOL = 3;
const MAX_PROMPT_CHARS = 1500;

// Property names like these appear everywhere; grepping them only produces noise.
const GENERIC_PROPERTIES = new Set([
  'id', 'name', 'type', 'value', 'data', 'item', 'items', 'key', 'keys', 'index', 'error', 'result',
  'status', 'path', 'file', 'user', 'text', 'message', 'default', 'config', 'options', 'props', 'state',
  'args', 'params', 'callback', 'context', 'list', 'label', 'title', 'body', 'size', 'count', 'time', 'date',
]);

const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'else', 'do', 'try', 'finally', 'with',
  'new', 'typeof', 'await', 'yield', 'case', 'default', 'throw', 'delete', 'void', 'in', 'of', 'import',
  'export', 'super', 'this', 'constructor', 'class', 'const', 'let', 'var',
]);

const PATTERNS = [
  { kind: 'function', re: /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_]\w*)\s*(\([^)]*\)?)/, sig: (m) => m[2] },
  { kind: 'class', re: /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_]\w*)([^{]*)/, sig: (m) => m[2] },
  { kind: 'interface', re: /^(?:export\s+)?interface\s+([A-Za-z_]\w*)([^{]*)/, sig: (m) => m[2] },
  { kind: 'type', re: /^(?:export\s+)?type\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*=\s*(.*)/, sig: (m) => m[2] },
  { kind: 'enum', re: /^(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_]\w*)()/, sig: () => '' },
  { kind: 'variable', re: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*(?::[^=]+)?=\s*(.*)/, sig: (m) => m[2] },
  { kind: 'method', re: /^(?:(?:public|private|protected|static|async|get|set)\s+)*([A-Za-z_]\w*)\s*(\([^)]*\))\s*(?::[^{]+)?\s*\{/, sig: (m) => m[2] },
  { kind: 'property', re: /^([A-Za-z_]\w*)\s*:\s*(.*)$/, sig: (m) => m[2] },
];

const normalizeSignature = (text) =>
  (text ?? '').replace(/\s+/g, ' ').replace(/[\s;,{(\[]+$/, '').trim();

// Splits on commas that are not inside brackets or strings, so a line holding several
// `key: value` pairs (models often collapse lines) is read as separate properties.
const splitTopLevel = (text) => {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
};

// Map of declared name -> { kind, signature } found in a code fragment (first declaration wins).
export const extractDeclarations = (text) => {
  const declarations = new Map();
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    for (const { kind, re, sig } of PATTERNS) {
      const m = line.match(re);
      if (!m) continue;
      if (kind === 'property') {
        for (const segment of splitTopLevel(line)) {
          const pm = segment.match(/^([A-Za-z_]\w*)\s*:\s*(.*)$/);
          if (pm && !KEYWORDS.has(pm[1]) && !declarations.has(pm[1])) {
            declarations.set(pm[1], { kind, signature: normalizeSignature(pm[2]) });
          }
        }
        break;
      }
      const name = m[1];
      if (!KEYWORDS.has(name) && !declarations.has(name)) {
        declarations.set(name, { kind, signature: normalizeSignature(sig(m)) });
      }
      break;
    }
  }
  return declarations;
};

const sameDeclaration = (a, b) => (!a && !b) || Boolean(a && b && a.kind === b.kind && a.signature === b.signature);

const isFunctionLike = ({ kind, signature }) =>
  kind === 'function' || kind === 'method' || (kind === 'variable' && /=>|^(?:async\s+)?function\b/.test(signature));

const describeChange = (decl) => {
  if (isFunctionLike(decl)) return 'signature changed';
  if (['class', 'interface', 'type', 'enum'].includes(decl.kind)) return 'definition changed';
  return 'value changed';
};

const isEligibleSymbol = (name, kind) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return false;
  if (kind === 'property') return name.length >= 4 && !GENERIC_PROPERTIES.has(name.toLowerCase());
  return name.length >= 3;
};

const sideDeclarations = (hunk) => ({
  ours: extractDeclarations(hunk.ours),
  theirs: extractDeclarations(hunk.theirs),
  base: hunk.base === null ? null : extractDeclarations(hunk.base),
});

// Symbols whose declaration is not identical across ours, theirs and base.
const contestedSymbols = (hunk) => {
  const { ours, theirs, base } = sideDeclarations(hunk);
  const names = new Set([...ours.keys(), ...theirs.keys(), ...(base ? base.keys() : [])]);
  return [...names]
    .map((name) => ({ name, decl: ours.get(name) ?? theirs.get(name) ?? base?.get(name) }))
    .filter(({ name }) => {
      const o = ours.get(name);
      const t = theirs.get(name);
      const b = base ? base.get(name) : o;
      return !(sameDeclaration(o, t) && sameDeclaration(o, b));
    })
    .filter(({ name, decl }) => isEligibleSymbol(name, decl.kind))
    .map(({ name, decl }) => ({ name, kind: decl.kind }));
};

export const isTestFile = (file) =>
  /(^|\/)(__tests__|tests?|spec)\//i.test(file) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(file);

const defaultFinder = ({ cwd, symbol, excludeFile, excludeRange }) =>
  grepWord(cwd, symbol, { excludeFile, excludeRange });

const formatLocation = (ref) => `${ref.file}:${ref.line}`;

const formatUsages = (symbols) => {
  const lines = symbols.map(({ name, total, references }) => {
    const shown = references
      .slice(0, MAX_PROMPT_REFS_PER_SYMBOL)
      .map((r) => `${formatLocation(r)} \`${r.text}\``)
      .join('; ');
    return `- ${name} (${total} other use${total === 1 ? '' : 's'}): ${shown}`;
  });
  const text = lines.join('\n');
  return text.length > MAX_PROMPT_CHARS ? `${text.slice(0, MAX_PROMPT_CHARS)}\n...` : text;
};

// Finds where the contested symbols of one hunk are used elsewhere in the repo.
// Returns { symbols, text, lookup }: `lookup(name)` greps on demand (memoized) so a
// resolution that drops a symbol nobody disputed can still be checked.
export const gatherUsages = async ({ cwd, file, hunk, finder = defaultFinder }) => {
  const cache = new Map();
  const lookup = (name) => {
    if (!cache.has(name)) {
      cache.set(name, finder({ cwd, symbol: name, excludeFile: file, excludeRange: [hunk.startLine, hunk.endLine] }));
    }
    return cache.get(name);
  };

  const contested = contestedSymbols(hunk).slice(0, MAX_SYMBOLS_PER_HUNK);
  const found = await Promise.all(contested.map(async ({ name, kind }) => ({ name, kind, ...(await lookup(name)) })));
  const used = found.filter((s) => s.total > 0);

  return { symbols: used, text: formatUsages(used), lookup };
};

const NO_REFERENCES = { references: [], total: 0, files: [] };

const buildFlag = ({ name, change, discardedFrom, total, references }) => {
  const where = references.slice(0, MAX_FLAG_LOCATIONS).map(formatLocation).join(', ');
  const used = `is still used in ${total} other place${total === 1 ? '' : 's'} (${where}${total > MAX_FLAG_LOCATIONS ? ', ...' : ''})`;
  if (change === 'removed') return `"${name}" is removed but ${used}`;
  const discarded = discardedFrom.length > 1 ? "neither side's version is kept" : `the ${discardedFrom[0]} side's version is discarded`;
  return `"${name}" ${change}: ${discarded}, but "${name}" ${used}`;
};

// Compares the declarations in a proposed resolution with what each side did, and looks up
// who else uses anything that was dropped or changed. A side only counts as having
// "changed" a symbol relative to the base (or, without a base, relative to the other side).
export const assessResolution = async ({ hunk, resolution, usages }) => {
  const { ours, theirs, base } = sideDeclarations(hunk);
  const resolved = extractDeclarations(resolution);
  const names = new Set([...ours.keys(), ...theirs.keys(), ...(base ? base.keys() : [])]);

  const changedFromBase = (side, other, b) => !sameDeclaration(side, base ? b : other);
  const changes = [];

  for (const name of names) {
    const o = ours.get(name);
    const t = theirs.get(name);
    const b = base?.get(name);
    const r = resolved.get(name);
    let change = null;
    const discardedFrom = [];

    if (!r) {
      if (o || t) change = 'removed';
    } else {
      if (o && changedFromBase(o, t, b) && !sameDeclaration(r, o)) discardedFrom.push('ours');
      if (t && changedFromBase(t, o, b) && !sameDeclaration(r, t)) discardedFrom.push('theirs');
      if (discardedFrom.length > 0) change = describeChange(r);
    }
    if (!change) continue;

    const kind = (r ?? o ?? t).kind;
    const found = usages && isEligibleSymbol(name, kind) ? await usages.lookup(name) : NO_REFERENCES;
    const entry = {
      name,
      kind,
      change,
      discardedFrom,
      detail: { base: b?.signature, ours: o?.signature, theirs: t?.signature, resolved: r?.signature },
      references: found.references,
      total: found.total,
      files: found.files,
    };
    changes.push(entry);
  }

  const flags = changes.filter((c) => c.total > 0).map(buildFlag);
  const testFiles = [...new Set(changes.flatMap((c) => c.files.filter(isTestFile)))];

  return { changes, flags, testFiles };
};

// --- file level: who imports the conflicted file ---------------------------------------

const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/;

const moduleKey = (file) => file.replace(SOURCE_EXTENSION, '').replace(/\/index$/, '');

// Files that import `file` through a relative path. Alias imports (like "@/utils") are not
// resolved, so those importers are missed.
export const findImporters = async ({ cwd, file, grep = grepPattern }) => {
  if (!SOURCE_EXTENSION.test(file)) return [];
  const target = moduleKey(file);
  const leaf = path.posix.basename(target);
  if (!/^[\w.-]+$/.test(leaf)) return [];

  const escaped = leaf.replace(/[.]/g, '\\.');
  const hits = await grep(cwd, `['"][^'"]*/${escaped}(/index)?(\\.[cm]?[jt]sx?)?['"]`);

  const importers = hits
    .filter((hit) => /\b(?:from|require|import)\b/.test(hit.text))
    .filter((hit) => hit.file !== file)
    .filter((hit) => {
      const specifiers = [...hit.text.matchAll(/['"](\.{1,2}\/[^'"]*)['"]/g)].map((m) => m[1]);
      return specifiers.some((spec) => moduleKey(path.posix.join(path.posix.dirname(hit.file), spec)) === target);
    })
    .map((hit) => hit.file);

  return [...new Set(importers)];
};

export const defaultReferenceAgent = { gatherUsages, assessResolution, findImporters };
