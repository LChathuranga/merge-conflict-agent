import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const OUTPUT_TAIL_CHARS = 4000;
const CONFIG_FILE = '.merge-agent.json';

// Order matters: cheapest signal of a broken merge first is the test suite,
// then static checks, then the full build.
const CHECKS = [
  { name: 'test', scripts: ['test'] },
  { name: 'typecheck', scripts: ['typecheck', 'type-check', 'tsc'] },
  { name: 'lint', scripts: ['lint'] },
  { name: 'build', scripts: ['build'] },
];

const readJsonIfExists = async (file) => {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${error.message}`);
  }
};

const detectPackageManager = (cwd) => {
  if (existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
};

// `npm init` writes a placeholder test script that always fails; it is not a real check.
const isPlaceholderScript = (script) => /no test specified/i.test(script);

const normalizeConfigured = (entries) =>
  entries.map((entry, i) =>
    typeof entry === 'string'
      ? { name: `check ${i + 1}`, command: entry }
      : { name: entry.name ?? `check ${i + 1}`, command: entry.command }
  );

// Repo instructions win: .merge-agent.json { "validate": ["npm test", {"name": "lint", "command": "..."}] }
// otherwise fall back to well-known package.json scripts.
export const detectValidationCommands = async (cwd) => {
  const config = await readJsonIfExists(path.join(cwd, CONFIG_FILE));
  if (config && Array.isArray(config.validate)) {
    return { source: CONFIG_FILE, commands: normalizeConfigured(config.validate) };
  }

  const pkg = await readJsonIfExists(path.join(cwd, 'package.json'));
  const scripts = pkg?.scripts ?? {};
  const pm = detectPackageManager(cwd);

  const commands = CHECKS.flatMap(({ name, scripts: candidates }) => {
    const script = candidates.find((s) => typeof scripts[s] === 'string' && !isPlaceholderScript(scripts[s]));
    return script ? [{ name, command: `${pm} run ${script}` }] : [];
  });

  return { source: commands.length > 0 ? 'package.json' : 'none', commands };
};

const tail = (text) => (text.length > OUTPUT_TAIL_CHARS ? `...${text.slice(-OUTPUT_TAIL_CHARS)}` : text);

// A shell command spawns children (npm -> node -> test runner). Killing only the
// shell on timeout would leave those running, so the whole tree has to go.
const killProcessTree = (child) =>
  new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => resolve());
      return;
    }
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    resolve();
  });

const runStep = ({ cwd, name, command, timeoutMs }) =>
  new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group so the tree can be killed
    });

    const collect = (chunk) => {
      output += chunk;
      // Bound memory on chatty commands; only the tail is ever reported.
      if (output.length > OUTPUT_TAIL_CHARS * 4) output = output.slice(-OUTPUT_TAIL_CHARS * 2);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child);
    }, timeoutMs);

    const finish = (exitCode, extra = '') => {
      clearTimeout(timer);
      const passed = exitCode === 0 && !timedOut;
      resolve({
        name,
        command,
        status: passed ? 'passed' : 'failed',
        ...(passed ? {} : { exitCode, timedOut }),
        durationMs: Date.now() - started,
        output: tail(`${output}${extra}`),
      });
    };

    child.on('error', (error) => finish(null, error.message));
    child.on('close', (code) => finish(code));
  });

// Runs commands in order and stops at the first failure (later steps are marked skipped).
// `passed` is only true when at least one command ran and all of them succeeded.
export const runValidation = async ({ cwd, commands, onEvent = () => {}, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
  const steps = [];
  let failed = false;

  for (const { name, command } of commands) {
    if (failed) {
      steps.push({ name, command, status: 'skipped' });
      continue;
    }
    onEvent({ type: 'validating', name, command });
    const step = await runStep({ cwd, name, command, timeoutMs });
    steps.push(step);
    if (step.status === 'failed') failed = true;
  }

  return { ran: commands.length > 0, passed: commands.length > 0 && !failed, steps };
};

export const validateRepo = async ({ cwd, onEvent }) => {
  const { source, commands } = await detectValidationCommands(cwd);
  const result = await runValidation({ cwd, commands, onEvent });
  return { ...result, source };
};
