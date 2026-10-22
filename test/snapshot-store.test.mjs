import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectFacts } from '../scripts/collect.mjs';
import { writeSnapshot } from '../scripts/snapshot-store.mjs';
import { runCollectCli } from '../scripts/collect-cli.mjs';

const as_of = '2026-10-22T00:00:00.000Z', old = 'OLD_SNAPSHOT\n';
const row = { number: 1, title: '事实', body: null, state: 'open', created_at: as_of,
  updated_at: as_of, closed_at: null, html_url: 'https://github.com/a/b/issues/1' };
const data = await collectFacts({ projects: [{ id: 'a', repo: 'a/b' }, { id: 'b', repo: 'a/c' }] },
  { nowIso: as_of, fetchFn: async url => ({ status: 200, json: async () =>
    url.includes('/pulls?') ? [{ ...row, merged_at: null, head: { sha: 'a'.repeat(40) } }] : [row] }) });
async function setup(t, existing = true) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hac-store-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snapshotPath = path.join(dir, 'snapshots', 'projects.json');
  if (existing) { await fs.mkdir(path.dirname(snapshotPath)); await fs.writeFile(snapshotPath, old); }
  return snapshotPath;
}
async function failure(t, overrides) {
  const snapshotPath = await setup(t); let cleaned = 0, renamed = 0;
  const fsOps = { ...fs, rename: async (...args) => { renamed++; return fs.rename(...args); },
    ...overrides, unlink: async file => { cleaned++; assert.equal(file, snapshotPath + '.tmp');
      return fs.unlink(file); } };
  await assert.rejects(writeSnapshot(data, { fsOps, snapshotPath }));
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), old);
  assert.equal(cleaned, 1); assert.equal(renamed, 0);
  assert.deepEqual(await fs.readdir(path.dirname(snapshotPath)), ['projects.json']);
}
test('Given 合法双项目 `collectFacts` 数据，When `writeSnapshot` 写入不存在的目标，Then 在临时测试目录出现一个 `projects.json`，顶层键精确为 `as_of`、`projects`，原始事实逐字段一致，任何层不含 `age_seconds`，`.tmp` 不存在。', async t => {
  const snapshotPath = await setup(t, false);
  await writeSnapshot(data, { snapshotPath });
  const raw = await fs.readFile(snapshotPath, 'utf8'), parsed = JSON.parse(raw);
  assert.deepEqual(parsed, data); assert.deepEqual(Object.keys(parsed).sort(), ['as_of', 'projects']);
  assert.doesNotMatch(raw, /"age_seconds":/);
  assert.deepEqual(await fs.readdir(path.dirname(snapshotPath)), ['projects.json']);
});
test('Given 目标已有固定原字节 `OLD_SNAPSHOT\n`，When 写入合法新数据且 rename 成功，Then 目标内容等于新数据序列化结果，且旧内容不残留；When 使用 Windows 实体 fs 覆盖已有目标，Then 记录 `win32`、Node 版本、成功/失败结果；若失败立即停机报告，禁止自动先删后换。', async t => {
  const snapshotPath = await setup(t);
  await fs.writeFile(snapshotPath + '.tmp', '上次残留');
  await writeSnapshot(data, { snapshotPath });
  assert.equal(await fs.readFile(snapshotPath, 'utf8'), JSON.stringify(data));
  assert.deepEqual(await fs.readdir(path.dirname(snapshotPath)), ['projects.json']);
  t.diagnostic(JSON.stringify({ platform: process.platform, node: process.version,
    windows: os.release(), result: 'success', before: old, after: await fs.readFile(snapshotPath, 'utf8') }));
});
test('Given 已存在快照字节为 `OLD_SNAPSHOT\n`，When 注入 `writeFile` 失败，Then `writeSnapshot` 拒绝、旧快照字节精确仍为 `OLD_SNAPSHOT\n`，且尝试清理 `.tmp`。', async t => {
  await failure(t, { writeFile: async file => { await fs.writeFile(file, 'partial'); throw Error('write'); } });
});
test('Given 同样旧快照，When 注入 `readFile(tmp)` 返回不可解析 JSON、缺少 `as_of` 或含 `age_seconds`，Then 每种情况均拒绝写入，旧快照字节保持原样、`rename` 调用次数为 0，并尝试清理 `.tmp`。', async t => {
  for (const raw of ['{', JSON.stringify({ projects: data.projects }),
    JSON.stringify({ ...data, age_seconds: 0 }), JSON.stringify({ ...data, projects: [] }),
    JSON.stringify({ ...data, projects: [{ id: 'changed', issues: [], prs: [] }] })])
    await failure(t, { readFile: async () => raw });
  await failure(t, { readFile: async () => { throw Error('read'); } });
});
test('Given 同样旧快照，When 注入 `rename` 拒绝，Then 旧快照字节保持原样且尝试清理 `.tmp`；Given 再注入 `unlink` 拒绝，When CLI 捕获失败，Then 返回 `1`、stdout 空、stderr 含 `SNAPSHOT_ERROR` 与 `snapshots/projects.json.tmp`。', async t => {
  await failure(t, { rename: async () => { throw Error('rename'); } });
  const snapshotPath = await setup(t); let stdout = '', stderr = '', cleaned = 0;
  const fsOps = { ...fs, rename: async () => { throw Error('rename'); },
    unlink: async () => { cleaned++; throw Error('cleanup secret'); } };
  assert.equal(await runCollectCli({ readFile: async () => '{}', collect: async () => data,
    save: (value, options) => writeSnapshot(value, { ...options, fsOps }), snapshotPath,
    stdout: { write: s => { stdout += s; } }, stderr: { write: s => { stderr += s; } } }), 1);
  assert.equal(stdout, ''); assert.equal(stderr, 'SNAPSHOT_ERROR: snapshots/projects.json.tmp\n');
  assert.equal(cleaned, 1); assert.equal(await fs.readFile(snapshotPath, 'utf8'), old);
  assert.deepEqual((await fs.readdir(path.dirname(snapshotPath))).sort(), ['projects.json', 'projects.json.tmp']);
});
test('Given 任意无效 `as_of`、`projects`、缺少顶层键、额外顶层键或嵌套 `age_seconds`，When `writeSnapshot`，Then 在文件写入与 rename 前拒绝，旧快照字节精确不变，原数据对象未修改。', async t => {
  const snapshotPath = await setup(t); let touched = 0;
  const fsOps = Object.fromEntries(['mkdir', 'writeFile', 'readFile', 'rename', 'unlink']
    .map(key => [key, async () => { touched++; throw Error(key); }]));
  const invalid = [null, {}, { projects: data.projects }, { as_of }, { ...data, extra: 1 },
    ...[null, '', 'bad', '2026-02-30T00:00:00Z', '2026-10-22T00:00:00', '2026-10-22T01:00:00+01:00']
      .map(as_of => ({ ...data, as_of })), ...[null, {}, [], [data.projects[0], data.projects[0]],
      [{ ...data.projects[0], extra: 0 }], [{ id: 1, issues: [], prs: [] }],
      [{ id: 'a', issues: null, prs: [] }], [{ id: 'a', issues: [], prs: {} }]]
      .map(projects => ({ ...data, projects }))];
  for (const key of ['age_seconds', 'risk', 'qa', 'scope', 'tested_commit'])
    invalid.push({ ...data, projects: [{ ...data.projects[0], issues: [{ ...row, nested: { [key]: 0 } }] }] });
  invalid.push({ ...data, extra: undefined }, { ...data, projects: [{ id: 'a', issues: [NaN], prs: [] }] },
    { ...data, projects: [{ id: 'a', issues: [1n], prs: [] }] });
  const circular = { ...data }; circular.projects = [circular]; invalid.push(circular);
  for (const value of invalid) {
    const before = structuredClone(value);
    await assert.rejects(writeSnapshot(value, { fsOps, snapshotPath })); assert.deepEqual(value, before);
  }
  assert.equal(touched, 0); assert.equal(await fs.readFile(snapshotPath, 'utf8'), old);
});
