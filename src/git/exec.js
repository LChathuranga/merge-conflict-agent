import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

export const runGit = async (cwd, args, { allowFailure = false } = {}) => {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    });
    return { stdout, stderr, ok: true };
  } catch (error) {
    if (!allowFailure) {
      throw new Error(`git ${args.join(' ')} failed: ${(error.stderr || error.message).trim()}`);
    }
    return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', ok: false };
  }
};
