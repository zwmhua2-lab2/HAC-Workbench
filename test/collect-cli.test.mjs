import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectFacts } from '../scripts/collect.mjs';
import { runCollectCli } from '../scripts/collect-cli.mjs';

const as_of = '2026-10-22T00:00:00.000Z';
const manifest = JSON.parse(await fs.readFile(new URL('../projects.json', import.meta.url), 'utf8'));
const data = { as_of, projects: manifest.projects.map(({ id }) => ({ id, issues: [], prs: [] })) };
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hac-cli-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir;
}
async function run(options) {
  let stdout = '', stderr = '';
  const code = await runCollectCli({ readFile: async () => JSON.stringify(manifest),
    stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } }, ...options });
  return { code, stdout, stderr };
}
test("Given 假 `collect` 抛出 `{code:'COLLECT_ERROR',exitCode:1}`，或模拟超时/403/429/非 2xx/畸形响应导致该错误，When `runCollectCli`，Then 返回 `1`，stderr 精确为 `COLLECT_ERROR\n`，`save` 调用 0 次；真实临时快照目录的文件数及文件字节在采集前后完全一致（**必须断言文件数，不得只断言退出码**）。", async t => {
  const dir = await setup(t), snapshotPath = path.join(dir, 'projects.json');
  await fs.writeFile(snapshotPath, 'OLD_SNAPSHOT\n'); await fs.writeFile(snapshotPath + '.tmp', 'residue');
  const files = async () => Promise.all((await fs.readdir(dir)).sort().map(async file =>
    [file, await fs.readFile(path.join(dir, file), 'utf8')]));
  const before = await files(); let saved = 0;
  const collectors = [async () => { throw { code: 'COLLECT_ERROR', exitCode: 1 }; },
    ...[403, 429, 500, 200].map(status => input => collectFacts(input, { nowIso: as_of,
      fetchFn: async () => ({ status, json: async () => ({}) }) })),
    input => collectFacts(input, { nowIso: as_of, fetchFn: () => new Promise(() => {}),
      setTimer: fn => { queueMicrotask(fn); return 1; }, clearTimer: () => {} })];
  for (const collect of collectors) {
    assert.deepEqual(await run({ collect, save: async () => { saved++; }, snapshotPath }),
      { code: 1, stdout: '', stderr: 'COLLECT_ERROR\n' });
    assert.equal((await fs.readdir(dir)).length, before.length); assert.deepEqual(await files(), before);
  }
  assert.equal(saved, 0);
});
test('Given 根目录清单读取失败或非法 JSON，When CLI 运行，Then 返回 `1`、stdout 空、stderr `SNAPSHOT_ERROR\n`，`collect` 与 `save` 调用次数均为 0，既有快照字节不变。', async t => {
  const snapshotPath = path.join(await setup(t), 'projects.json'); await fs.writeFile(snapshotPath, 'OLD_SNAPSHOT\n');
  let calls = 0;
  for (const readFile of [async () => { throw Error('secret'); }, async () => '{']) {
    assert.deepEqual(await run({ readFile, collect: () => { calls++; }, save: () => { calls++; }, snapshotPath }),
      { code: 1, stdout: '', stderr: 'SNAPSHOT_ERROR\n' });
    assert.equal(calls, 0); assert.equal(await fs.readFile(snapshotPath, 'utf8'), 'OLD_SNAPSHOT\n');
  }
});
test('Given 合法清单及假 collect/save 成功，When CLI 运行，Then `collect` 收到 `projects` 双项目对象和 `nowIso` UTC ISO，`save` 收到完整事实，CLI 返回 `0`，stdout `SNAPSHOT_OK\n`，stderr 为空；不调用 P3 状态映射、不读取任何凭据。', async () => {
  let saved = 0;
  assert.deepEqual(await run({ now: () => as_of, snapshotPath: 'injected', readFile: async (file, encoding) => {
    assert.equal(fileURLToPath(file), fileURLToPath(new URL('../projects.json', import.meta.url)));
    assert.equal(encoding, 'utf8'); return JSON.stringify(manifest);
  }, collect: async (input, options) => { assert.deepEqual(input, manifest);
    assert.deepEqual(options, { nowIso: as_of }); return data; },
  save: async (value, options) => { saved++; assert.deepEqual(value, data);
    assert.deepEqual(options, { snapshotPath: 'injected' }); } }), { code: 0, stdout: 'SNAPSHOT_OK\n', stderr: '' });
  assert.equal(saved, 1);
  assert.deepEqual(await run({ collect: async () => data, save: async () => { throw Error('secret'); } }),
    { code: 1, stdout: '', stderr: 'SNAPSHOT_ERROR\n' });
});
test('Given `node --test` 与两项新增测试文件，When 全量执行，Then 现有 collector/status 测试及本卡原子写/CLI 测试全部通过、命令退出 0；若断言失败则非 0。Given PR diff，When Human 终审，Then 仅本卡白名单文件变化，≤300 行，无新增依赖；未经本机 Windows 实测不得宣称其覆盖行为已验证。', async t => {
  const dir = await setup(t); await fs.mkdir(path.join(dir, 'scripts'));
  for (const file of ['collect-cli.mjs', 'snapshot-store.mjs', 'collect.mjs']) {
    const source = await fs.readFile(new URL('../scripts/' + file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /process\.env|GITHUB_TOKEN|PAT|derive-status|process\.exit\s*\(/);
    await fs.writeFile(path.join(dir, 'scripts', file), source);
  }
  const bootstrap = 'data:text/javascript,' + encodeURIComponent('globalThis.fetch = async () => ({status:200,json:async()=>[]});');
  for (const valid of [true, false]) {
    await fs.writeFile(path.join(dir, 'projects.json'), valid ? JSON.stringify(manifest) : '{');
    const result = spawnSync(process.execPath, ['--import', bootstrap, path.join(dir, 'scripts/collect-cli.mjs')],
      { cwd: os.tmpdir(), encoding: 'utf8' });
    assert.equal(result.status, valid ? 0 : 1);
    assert.equal(result.stdout, valid ? 'SNAPSHOT_OK\n' : '');
    assert.equal(result.stderr, valid ? '' : 'SNAPSHOT_ERROR\n');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'snapshots/projects.json'), 'utf8')).projects, data.projects);
  }
});
