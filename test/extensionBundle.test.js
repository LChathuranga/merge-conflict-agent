import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'extension', 'package.json'), 'utf8'));
const esbuildPath = path.join(root, 'extension', 'node_modules', 'esbuild');
const haveEsbuild = existsSync(esbuildPath);

const STUB_VSCODE = readFileSync(path.join(root, 'test-support', 'stubVscode.cjs'), 'utf8');

const bundleInto = async (dir) => {
  const { build } = createRequire(import.meta.url)(esbuildPath);
  mkdirSync(path.join(dir, 'node_modules', 'vscode'), { recursive: true });
  writeFileSync(path.join(dir, 'node_modules', 'vscode', 'index.js'), STUB_VSCODE);
  const outfile = path.join(dir, 'extension.js');
  await build({
    entryPoints: [path.join(root, 'src', 'ui', 'vscode', 'extension.js')],
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], logLevel: 'silent',
  });
  return outfile;
};

test('the manifest keeps its safety promises', () => {
  assert.equal(manifest.main, './dist/extension.js');
  assert.deepEqual(manifest.extensionKind, ['workspace']);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false, 'validation runs repo scripts, so no untrusted workspaces');
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  assert.equal(manifest.contributes.configuration.properties['mergeAssistant.useTools'].default, false, 'tool calling is opt-in');
  assert.equal(manifest.contributes.configuration.properties['mergeAssistant.provider'].default, 'ollama', 'local by default');
  assert.ok(manifest.contributes.viewsContainers.activitybar.some((c) => c.id === 'mergeAssistant'));
  assert.ok(manifest.contributes.views.mergeAssistant.some((v) => v.id === 'mergeAssistant.steps'));
  assert.match(manifest.engines.vscode, /^\^1\.\d+\.\d+$/);
});

test('every contributed command is registered by activate(), and nothing undeclared is', { skip: !haveEsbuild && 'run "npm install" in extension/ first' }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mca-bundle-'));
  try {
    const outfile = await bundleInto(dir);
    const source = readFileSync(outfile, 'utf8');
    assert.ok(!/import\.meta/.test(source), 'no import.meta survives in the bundle');
    assert.ok(!/dotenv/.test(source), 'the CLI-only env loader is not bundled');

    const extension = createRequire(outfile)(outfile);
    assert.equal(typeof extension.activate, 'function');
    assert.equal(typeof extension.deactivate, 'function');

    const secrets = new Map();
    await extension.activate({
      subscriptions: [],
      secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k) },
      globalState: { get: (k, d) => d, update: async () => {} },
    });

    const declared = manifest.contributes.commands.map((c) => c.command).sort();
    const registered = [...globalThis.__mcaRegistered.keys()].sort();
    assert.deepEqual(registered, declared, 'manifest and registered commands match exactly');
  } finally {
    delete globalThis.__mcaRegistered;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a person with no merge in progress can find both the merge and the cherry-pick check', () => {
  const welcome = manifest.contributes.viewsWelcome.find((w) => /No merge in progress/.test(w.contents));
  assert.match(welcome.contents, /\(command:mergeAssistant\.mergeBranch\)/);
  assert.match(welcome.contents, /\(command:mergeAssistant\.checkCherryPick\)/);
  assert.match(welcome.contents, /A merge never commits on its own, and files are staged only when you click Stage/);
  assert.doesNotMatch(welcome.contents, /never stages/, 'the old, now untrue promise is gone');

  const toolbar = manifest.contributes.menus['view/title'].filter((e) => e.group.startsWith('navigation'));
  for (const command of ['mergeAssistant.mergeBranch', 'mergeAssistant.checkCherryPick']) {
    const entry = toolbar.find((e) => e.command === command);
    assert.ok(entry, `${command} has a toolbar button`);
    assert.match(entry.when, /!mergeAssistant\.mergeInProgress/, `${command} is hidden during a merge`);
  }
});
