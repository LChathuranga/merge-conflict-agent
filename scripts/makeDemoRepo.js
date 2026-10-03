// Builds a throwaway git repo that is mid-merge with three conflicts of rising difficulty.
// Usage: node scripts/makeDemoRepo.js [targetDir]   (targetDir must not exist or be empty)
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = process.argv[2]
  ? path.resolve(process.argv[2])
  : mkdtempSync(path.join(tmpdir(), 'merge-conflict-demo-'));

if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`Refusing to use non-empty directory: ${target}`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const write = (file, text) => {
  mkdirSync(path.dirname(path.join(target, file)), { recursive: true });
  writeFileSync(path.join(target, file), text);
};

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'demo@example.com');
git('config', 'user.name', 'Demo');
git('config', 'core.autocrlf', 'false');
git('config', 'merge.conflictstyle', 'diff3');

const BASE = {
  // Easy: both sides touch adjacent lines; correct answer keeps both changes.
  'config.js': `export const config = {
  timeout: 30,
};
`,
  // Medium: both sides rewrite the same function for different features.
  'price.js': `export const calculateTotal = (items) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return subtotal;
};
`,
  // Hard / ambiguous: both sides set the same constant to contradictory values.
  'auth.js': `// Session lifetime for logged-in users
export const SESSION_MINUTES = 30;
`,
};

// Untouched by either branch: they use the contested names, so the Reference Agent has something to find.
const CALLERS = {
  'package.json': `{ "name": "demo", "type": "module", "scripts": { "test": "node --test" } }
`,
  'checkout.js': `import { calculateTotal } from './price.js';
import { config } from './config.js';

export const checkout = (items) => ({ total: calculateTotal(items), timeout: config.timeout });
`,
  'session.js': `import { SESSION_MINUTES } from './auth.js';

export const expiresInMs = () => SESSION_MINUTES * 60 * 1000;
`,
  'test/checkout.test.js': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateTotal } from '../price.js';

test('total is a number', () => {
  assert.equal(typeof calculateTotal([{ price: 1, qty: 2 }]), 'number');
});
`,
};

const OURS = {
  'config.js': `export const config = {
  timeout: 60,
};
`,
  'price.js': `export const calculateTotal = (items) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = subtotal * 0.2;
  return subtotal + tax;
};
`,
  'auth.js': `// Session lifetime for logged-in users
export const SESSION_MINUTES = 15;
`,
};

const THEIRS = {
  'config.js': `export const config = {
  timeout: 30,
  retries: 3,
};
`,
  'price.js': `export const calculateTotal = (items) => {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const discount = subtotal > 100 ? subtotal * 0.1 : 0;
  return subtotal - discount;
};
`,
  'auth.js': `// Session lifetime for logged-in users
export const SESSION_MINUTES = 120;
`,
};

const commitAll = (files, message) => {
  Object.entries(files).forEach(([file, text]) => write(file, text));
  git('add', '.');
  git('commit', '-q', '-m', message);
};

commitAll({ ...BASE, ...CALLERS }, 'base');
git('checkout', '-q', '-b', 'feature');
commitAll(THEIRS, 'feature: retries, discount, longer sessions');
git('checkout', '-q', 'main');
commitAll(OURS, 'main: longer timeout, tax, shorter sessions');

try {
  git('merge', 'feature');
} catch {
  // conflicts are expected
}

console.log(`Demo repo with 3 conflicts created at:\n  ${target}\n`);
console.log('Try it:');
console.log(`  cd "${target}"`);
console.log('  resolve-conflicts --dry-run');
console.log('\nExpected: config.js and price.js resolved by combining both sides;');
console.log('auth.js (15 vs 120 minutes) should be flagged for your approval.');
console.log('checkout.js, session.js and test/checkout.test.js use the contested names, so the');
console.log('Reference Agent should report where they are used, and --validate runs that test first.');
