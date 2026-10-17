// Keeps the core reusable by both the CLI and the VS Code extension:
//  - only src/ui/vscode may import the VS Code API
//  - src may not use import.meta or dotenv (they break once the core is bundled into an
//    extension), except src/config/loadEnv.js, which only the CLI imports
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const VSCODE_DIR = path.join(srcDir, 'ui', 'vscode');
const ENV_LOADER = path.join(srcDir, 'config', 'loadEnv.js');

const VSCODE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]vscode['"]/;
const IMPORT_META = /\bimport\.meta\b/;
const DOTENV_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]dotenv['"]/;

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  );
  return nested.flat().filter((f) => /\.(js|mjs|cjs)$/.test(f));
};

const files = await walk(srcDir);
const violations = [];
const report = (file, reason) => violations.push(`${path.relative(srcDir, file)}: ${reason}`);

for (const file of files) {
  const text = await readFile(file, 'utf8');
  if (!file.startsWith(VSCODE_DIR + path.sep) && VSCODE_IMPORT.test(text)) {
    report(file, 'imports "vscode" outside src/ui/vscode');
  }
  if (file !== ENV_LOADER && IMPORT_META.test(text)) report(file, 'uses import.meta (breaks when bundled to CommonJS)');
  if (file !== ENV_LOADER && DOTENV_IMPORT.test(text)) report(file, 'imports dotenv (only src/config/loadEnv.js may)');
}

if (violations.length > 0) {
  console.error(`Architecture violations:\n  ${violations.join('\n  ')}`);
  process.exit(1);
}

console.log(`Architecture OK (${files.length} files checked)`);
