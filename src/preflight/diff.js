import { builtinModules } from 'node:module';
import { extractDeclarations } from '../agents/referenceAgent.js';

// Pure text parsing, no git and no disk: easy to test and safe to reuse from any UI.

const stripPrefix = (p) => {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '').replace(/\t.*$/, '');
};

// Parses `git show -U0` output into
// [{ oldPath, newPath, hunks: [{ oldStart, oldCount, newStart, newCount, added: [], removed: [] }] }].
export const parseUnifiedDiff = (text) => {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = { oldPath: null, newPath: null, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;

    // "---" / "+++" are headers only before the first hunk; inside a hunk they are content.
    if (!hunk && line.startsWith('--- ')) { file.oldPath = stripPrefix(line.slice(4)); continue; }
    if (!hunk && line.startsWith('+++ ')) { file.newPath = stripPrefix(line.slice(4)); continue; }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      hunk = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        added: [],
        removed: [],
      };
      file.hunks.push(hunk);
      oldLine = hunk.oldStart;
      newLine = hunk.newStart;
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith('+')) { hunk.added.push({ line: newLine, text: line.slice(1) }); newLine += 1; }
    else if (line.startsWith('-')) { hunk.removed.push({ line: oldLine, text: line.slice(1) }); oldLine += 1; }
    else if (line.startsWith(' ')) { oldLine += 1; newLine += 1; }
  }
  return files;
};

const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/i;
export const isCodeFile = (file) => CODE_FILE.test(file);

// Names that are never worth looking for on another branch: language words, globals, builtins.
const NOT_WORTH_CHECKING = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'async', 'import', 'export', 'super',
  'constructor', 'require', 'new', 'delete', 'void', 'throw', 'yield', 'console', 'Promise', 'Array', 'Object', 'String',
  'Number', 'Boolean', 'Symbol', 'BigInt', 'JSON', 'Math', 'Date', 'Error', 'TypeError', 'RangeError', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'RegExp', 'Buffer', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'setTimeout',
  'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'fetch', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent', 'describe', 'it', 'test', 'expect',
  'beforeEach', 'afterEach', 'beforeAll', 'afterAll', 'jest', 'vi', 'assert', 'process', 'module', 'exports',
]);

const stripCommentsAndStrings = (code) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

const packageNameOf = (specifier) => {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

// What a block of added JS/TS code depends on: bare function calls, imported names,
// relative files and npm packages. Names the same code declares itself are left out.
export const extractUsedNames = (addedCode) => {
  const relativeImports = new Set();
  const packages = new Set();
  for (const [, , specifier] of addedCode.matchAll(IMPORT_SPECIFIER)) {
    if (specifier.startsWith('.')) relativeImports.add(specifier);
    else if (!specifier.startsWith('/') && !specifier.startsWith('node:') && !builtinModules.includes(packageNameOf(specifier))) {
      packages.add(packageNameOf(specifier));
    }
  }

  // Names imported from packages or Node built-ins say nothing about this repository, so only
  // names imported from the project's own files are looked up on the target branch.
  const names = new Set();
  for (const [, list] of addedCode.matchAll(/\bimport\s*\{([^}]*)\}\s*from\s*['"]\.{1,2}\//g)) {
    for (const part of list.split(',')) {
      const original = part.trim().split(/\s+as\s+/)[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(original)) names.add(original);
    }
  }

  const code = stripCommentsAndStrings(addedCode);
  for (const [, name] of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(name);

  const declaredHere = new Set(extractDeclarations(code).keys());
  const symbols = [...names].filter((n) => n.length >= 3 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !NOT_WORTH_CHECKING.has(n) && !declaredHere.has(n));

  return { symbols, relativeImports: [...relativeImports], packages: [...packages] };
};

const RESOLVE_EXTENSIONS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];

// Repo-relative candidates a relative import could refer to, most likely first.
export const importCandidates = (fromFile, specifier) => {
  const base = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const joined = base ? `${base}/${specifier}` : specifier;
  const parts = [];
  for (const part of joined.split('/')) {
    if (part === '..') parts.pop();
    else if (part && part !== '.') parts.push(part);
  }
  const target = parts.join('/');
  return [
    ...RESOLVE_EXTENSIONS.map((ext) => `${target}${ext}`),
    ...RESOLVE_EXTENSIONS.slice(1, 6).map((ext) => `${target}/index${ext}`),
  ];
};
