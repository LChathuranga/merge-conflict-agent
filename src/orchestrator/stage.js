import { listConflictedFiles, readWorkingFile, stageFile } from '../git/index.js';
import { hasConflictMarkers } from '../conflict/parser.js';

// Stages files the user has approved, telling Git they are resolved. It never commits.
// Each file is re-checked at the moment of staging: only files Git still lists as unmerged,
// that can be read, and that have no conflict markers left are staged, so a stale list can
// never mark a broken file as resolved.
export const stageResolvedFiles = async ({ cwd, files }) => {
  const unmerged = new Set(await listConflictedFiles(cwd));
  const staged = [];
  const refused = [];

  for (const file of files) {
    if (!unmerged.has(file)) {
      refused.push({ file, reason: 'is not an unmerged file' });
      continue;
    }
    let text;
    try {
      text = await readWorkingFile(cwd, file);
    } catch {
      refused.push({ file, reason: 'could not be read' });
      continue;
    }
    if (hasConflictMarkers(text)) {
      refused.push({ file, reason: 'still has conflict markers' });
      continue;
    }
    try {
      await stageFile(cwd, file);
      staged.push(file);
    } catch (error) {
      refused.push({ file, reason: error.message });
    }
  }
  return { staged, refused };
};
