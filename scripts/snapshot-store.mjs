import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const defaultPath = fileURLToPath(new URL('../snapshots/projects.json', import.meta.url));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function requireValid(condition) {
  if (!condition) throw Error('Invalid snapshot');
}
const keys = (value, expected) => record(value)
  && isDeepStrictEqual(Object.keys(value).sort(), expected);
function utc(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value);
  if (!parts) return false;
  const normalized = parts[1] + '.' + (parts[2] ?? '').padEnd(3, '0').slice(0, 3) + 'Z';
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) && new Date(millis).toISOString() === normalized;
}
function validate(data) {
  requireValid(keys(data, ['as_of', 'projects']) && utc(data.as_of)
    && Array.isArray(data.projects) && data.projects.length > 0);
  const ids = new Set();
  for (const project of data.projects) {
    requireValid(keys(project, ['id', 'issues', 'prs']) && typeof project.id === 'string'
      && !ids.has(project.id) && Array.isArray(project.issues) && Array.isArray(project.prs));
    ids.add(project.id);
  }
  function visit(value) {
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      requireValid(!['age_seconds', 'risk', 'qa', 'scope', 'tested_commit'].includes(key));
      visit(child);
    }
  }
  visit(data);
}

/** Validate in memory, then verify the same-directory temporary file before replacement. */
export async function writeSnapshot(data, { fsOps = fs, snapshotPath } = {}) {
  snapshotPath ??= defaultPath;
  const serialized = JSON.stringify(data), expected = JSON.parse(serialized);
  requireValid(isDeepStrictEqual(expected, data));
  validate(data);
  const temporaryPath = snapshotPath + '.tmp';
  await fsOps.mkdir(dirname(snapshotPath), { recursive: true });
  try {
    await fsOps.writeFile(temporaryPath, serialized, 'utf8');
    const restored = JSON.parse(await fsOps.readFile(temporaryPath, 'utf8'));
    validate(restored);
    requireValid(isDeepStrictEqual(restored, data));
    await fsOps.rename(temporaryPath, snapshotPath);
  } catch (cause) {
    try { await fsOps.unlink(temporaryPath); }
    catch (cleanup) {
      if (cleanup.code !== 'ENOENT') throw Object.assign(new Error('Snapshot cleanup failed', { cause }),
        { code: 'SNAPSHOT_CLEANUP_ERROR', temporaryPath });
    }
    throw cause;
  }
}
