// Builds a repo with ONE file (settings.js) that has five separate conflicts when `feature` is merged into `main`.
// Usage: node scripts/makeFiveConflicts.js <targetDir> [--no-merge]
//   targetDir must not exist or be empty. --no-merge leaves both branches ready for "Merge a Branch..." in the UI.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const startMerge = !args.includes('--no-merge');
const [targetArg] = args.filter((a) => !a.startsWith('--'));
if (!targetArg) {
  console.error('Usage: node scripts/makeFiveConflicts.js <targetDir> [--no-merge]');
  process.exit(1);
}
const target = path.resolve(targetArg);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`Refusing to use non-empty directory: ${target}`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });

const git = (...a) => execFileSync('git', a, { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Five settings, each separated by unchanged filler lines so Git keeps them as five conflicts.
const SETTINGS = [
  ['timeoutMs', '1000', '5000', '2000'],
  ['retries', '1', '5', '3'],
  ['logLevel', "'info'", "'debug'", "'warn'"],
  ['pageSize', '10', '50', '25'],
  ['cacheTtlSeconds', '60', '600', '300'],
];
const build = (pick) => {
  const lines = ['// App settings', 'export const settings = {'];
  SETTINGS.forEach((s, i) => {
    lines.push(`  ${s[0]}: ${s[pick]},`);
    if (i < SETTINGS.length - 1) {
      for (let k = 1; k <= 4; k++) lines.push(`  // ${s[0]} notes ${k}`);
    }
  });
  lines.push('};', '');
  return lines.join('\n');
};
const put = (text) => writeFileSync(path.join(target, 'settings.js'), text);

git('init', '-q', '-b', 'main');
git('config', 'user.email', 'demo@example.com');
git('config', 'user.name', 'Demo');
git('config', 'merge.conflictstyle', 'diff3');
put(build(1));
git('add', '.');
git('commit', '-q', '-m', 'Initial settings');

git('checkout', '-q', '-b', 'feature');
put(build(2));
git('commit', '-qam', 'Tune settings for heavy load: bigger timeouts, more retries, bigger pages');

git('checkout', '-q', 'main');
put(build(3));
git('commit', '-qam', 'Tune settings for stability: moderate values, quieter logging');

if (startMerge) {
  try { git('merge', '--no-ff', '--no-commit', 'feature'); } catch { /* the conflicts are expected */ }
}
console.log(`Created ${target}${startMerge ? ' (merge started, 5 conflicts in settings.js)' : ' (branches main and feature ready to merge)'}`);
