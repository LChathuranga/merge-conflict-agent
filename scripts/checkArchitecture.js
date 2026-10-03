// Enforces: core modules must not depend on the VS Code API; only src/ui may.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const UI_DIR = path.join(srcDir, 'ui');
const VSCODE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]vscode['"]/;

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]))
  );
  return nested.flat().filter((f) => /\.(js|mjs|cjs)$/.test(f));
};

const files = await walk(srcDir);
const violations = [];

for (const file of files) {
  if (file.startsWith(UI_DIR + path.sep)) continue;
  if (VSCODE_IMPORT.test(await readFile(file, 'utf8'))) {
    violations.push(path.relative(srcDir, file));
  }
}

if (violations.length > 0) {
  console.error(`Architecture violation: these files import "vscode" outside src/ui:\n  ${violations.join('\n  ')}`);
  process.exit(1);
}

console.log(`Architecture OK (${files.length} files checked)`);
