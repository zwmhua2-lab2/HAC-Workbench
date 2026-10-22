import { readFile as fsReadFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { collectFacts } from './collect.mjs';
import { writeSnapshot } from './snapshot-store.mjs';

export async function runCollectCli({ readFile = fsReadFile, collect = collectFacts,
  save = writeSnapshot, now = () => new Date().toISOString(), manifestPath,
  snapshotPath, stdout = process.stdout, stderr = process.stderr } = {}) {
  let collecting = false;
  try {
    const manifest = JSON.parse(await readFile(manifestPath
      ?? new URL('../projects.json', import.meta.url), 'utf8'));
    collecting = true;
    const data = await collect(manifest, { nowIso: now() });
    collecting = false;
    await save(data, { snapshotPath });
    stdout.write('SNAPSHOT_OK\n');
    return 0;
  } catch (error) {
    const message = collecting && error?.code === 'COLLECT_ERROR' ? 'COLLECT_ERROR'
      : !collecting && error?.code === 'SNAPSHOT_CLEANUP_ERROR'
        ? 'SNAPSHOT_ERROR: snapshots/projects.json.tmp' : 'SNAPSHOT_ERROR';
    stderr.write(message + '\n');
    return 1;
  }
}

export function isMainModule(argv1, moduleUrl, realpathFn = realpathSync) {
  try { return Boolean(argv1) && realpathFn(argv1) === realpathFn(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

if (isMainModule(process.argv[1], import.meta.url))
  process.exitCode = await runCollectCli();
