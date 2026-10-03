// Builds a throwaway repo with a `main` branch and a `feature` branch so cherry-pick-check
// has something to say. Usage: node scripts/makePickDemo.js [targetDir]   (must not exist or be empty)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = process.argv[2] ? path.resolve(process.argv[2]) : mkdtempSync(path.join(tmpdir(), 'pick-demo-'));
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`Refusing to use non-empty directory: ${target}`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (files, message) => {
  Object.entries(files).forEach(([file, text]) => writeFileSync(path.join(target, file), text));
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD');
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'demo@example.com');
git('config', 'user.name', 'Demo');
git('config', 'core.autocrlf', 'false');

commit({ 'main.js': 'export const title = "app";\n', 'settings.js': 'export const retries = 3;\nexport const pageSize = 20;\n', 'cart.js': 'export const addToCart = (cart, item) => [...cart, item];\n' }, 'Initial commit');

git('checkout', '-q', '-b', 'feature');
const independent = commit({ 'footer.js': 'export const footer = "(c) Demo";\n' }, 'Add a footer');
const helper = commit({ 'helper.js': 'export const computeTotal = (items) => items.length * 2;\n' }, 'Add computeTotal helper');
const hidden = commit({ 'main.js': 'import { computeTotal } from "./helper.js";\nexport const title = "app";\nexport const total = computeTotal([1, 2]);\n' }, 'Show the cart total on the main page');
const added = commit({ 'settings.js': 'export const retries = 3;\nexport const pageSize = 20;\nexport const timeout = 30;\n' }, 'Add a timeout setting');
const edited = commit({ 'settings.js': 'export const retries = 3;\nexport const pageSize = 20;\nexport const timeout = 60;\n' }, 'Raise the timeout to 60');

git('checkout', '-q', 'main');
commit({ 'cart.js': 'export const addToCart = (cart, item) => [...cart, item];\nexport const clearCart = () => [];\n' }, 'Add clearCart on main');

console.log(`Demo repo created at:\n  ${target}\n`);
console.log('You are on main. Try these (each only reads the repo; nothing is changed):');
console.log(`  cd "${target}"`);
console.log(`  cherry-pick-check ${independent}     # "Add a footer": independent, expect SAFE (local analysis only)`);
console.log(`  cherry-pick-check ${hidden}     # "Show the cart total": applies cleanly but needs ${helper}, expect CONDITIONAL`);
console.log(`  cherry-pick-check ${edited}     # "Raise the timeout": edits a line added by ${added}, expect CONDITIONAL and a conflict`);
console.log('\nAdd --apply to be offered the real cherry-pick after the report, or --validate to also run tests.');
