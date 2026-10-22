import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deriveStatus } from '../scripts/derive-status.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/derive-status.json', import.meta.url)));
const issue = (patch = {}) => ({ ...fixture.issue, ...patch });
const pr = (patch = {}) => ({ ...fixture.pr, ...patch });
const derive = (i = issue(), prs = [], now = fixture.now) => deriveStatus(i, prs, now);

test("Given `issue.state='closed'`，且 PR 为 `{state:'closed',merged:false,qa:'FAIL',scope:'violation'}`，When 调用 `deriveStatus`，Then 返回 `已完成`（①优先）。", () => {
  assert.equal(derive(issue({ state: 'closed' }), [pr({ state: 'closed', qa: 'FAIL', scope: 'violation' })]), '已完成');
});

test("Given open Issue、存在 `{state:'closed',merged:false}` PR，When 推导，Then 返回 `异常`；Given open PR 的 `qa='FAIL'` 或 `scope='violation'`，When 分别推导，Then 均返回 `异常`（②）。", () => {
  for (const patch of [{ state: 'closed' }, { qa: 'FAIL' }, { scope: 'violation' }]) {
    assert.equal(derive(issue(), [pr(patch)]), '异常');
  }
});

test("Given open Issue，`created_at='2026-10-07T23:59:59.999Z'`、`prs=[]`、`nowIso='2026-10-22T00:00:00.000Z'`，When 推导，Then 返回 `异常`（③）。", () => {
  assert.equal(derive(issue({ created_at: '2026-10-07T23:59:59.999Z' })), '异常');
});

test("Given open Issue、`risk='unknown'`、`created_at='2026-10-21T00:00:00.000Z'`、`prs=[]`，When 推导，Then 返回 `未知`（④高于⑦）。", () => {
  assert.equal(derive(issue({ risk: 'unknown' })), '未知');
});

test("Given open Issue、`risk='高'`、有 open PR 且 `qa=null`，When 推导，Then 返回 `待质检`；Given `qa='PASS'`、`head_sha='abcdef12'`、`tested_commit='abc000'`，When 推导，Then 返回 `待质检`（⑤）。", () => {
  for (const patch of [{}, { qa: 'PASS', tested_commit: 'abc000' }]) {
    assert.equal(derive(issue({ risk: '高' }), [pr(patch)]), '待质检');
  }
});

test("Given open Issue、`risk='低'`、open PR 的 `qa=null`，When 推导，Then 返回 `待合并`；Given `risk='高'`、open PR 的 `qa='PASS'`、`head_sha='abcdef12'`、`tested_commit='abc'`，When 推导，Then 返回 `待合并`（⑥）。", () => {
  assert.equal(derive(issue(), [pr()]), '待合并');
  assert.equal(derive(issue({ risk: '高' }), [pr({ qa: 'PASS', tested_commit: 'abc' })]), '待合并');
});

test("Given open Issue、`risk='低'`、`prs=[]`、`created_at='2026-10-08T00:00:00.000Z'`、`nowIso='2026-10-22T00:00:00.000Z'`，When 推导，Then 返回 `待开工`（⑦恰好 14 天）。", () => {
  assert.equal(derive(issue({ created_at: '2026-10-08T00:00:00.000Z' })), '待开工');
});

test('Given open Issue、`risk=\'高\'`、仅有已合并且关闭的 PR，When 推导，Then 返回 `未知`（⑧）。', () => {
  assert.equal(derive(issue({ risk: '高' }), [pr({ state: 'closed', merged: true })]), '未知');
});

test("Given open Issue、无 PR、`created_at='invalid'`，When 推导，Then 返回 `未知`；Given高风险 open PR、`qa='PASS'`、`tested_commit=''`，When 推导，Then 返回 `待质检`，不得误判为空前缀匹配。", () => {
  assert.equal(derive(issue({ created_at: 'invalid' })), '未知');
  assert.equal(derive(issue({ risk: '高' }), [pr({ qa: 'PASS', tested_commit: '' })]), '待质检');
});

test('Given 冻结 fixtures，When `node --test`，Then 以上状态断言全部通过、退出码 0；Given 本卡测试中有不匹配的断言，When `node --test`，Then 退出码非 0；Given 原输入对象，When 推导，Then 输入对象及 PR 列表前后深度相等。', () => {
  const input = Object.freeze(issue());
  const prs = Object.freeze([Object.freeze(pr())]);
  const before = structuredClone({ input, prs });
  assert.equal(derive(input, prs), '待合并');
  assert.deepEqual({ input, prs }, before);
  if (process.env.DERIVE_STATUS_NEGATIVE_ASSERTION === '1') {
    assert.equal(derive(input, prs), '故意不匹配的断言');
  } else {
    const childEnv = { ...process.env, DERIVE_STATUS_NEGATIVE_ASSERTION: '1' };
    delete childEnv.NODE_TEST_CONTEXT; // Start a fresh runner, not an inherited test worker.
    const child = spawnSync(process.execPath, ['--test', '--test-name-pattern=^Given 冻结 fixtures', import.meta.filename], {
      env: childEnv, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stdout + child.stderr, /故意不匹配的断言/);
  }
});

test('多 PR 按异常、待质检、待合并排序，未知风险不掩盖超期或异常', () => {
  const ready = pr({ qa: 'PASS', tested_commit: 'abc' });
  for (const prs of [[ready, pr()], [pr(), ready]]) {
    assert.equal(derive(issue({ risk: '高' }), prs), '待质检');
    assert.equal(derive(issue({ risk: '高' }), [...prs, pr({ qa: 'FAIL' })]), '异常');
  }
  assert.equal(derive(issue({ risk: 'unknown', created_at: '2026-10-01T00:00:00Z' })), '异常');
  assert.equal(derive(issue({ risk: 'unknown' }), [pr({ scope: 'violation' })]), '异常');
  assert.equal(derive(issue({ risk: 'unknown' }), [ready]), '未知');
});

test('非法或缺失输入返回未知，关闭 Issue 优先于其余 PR 条件', () => {
  for (const input of [undefined, null, [], {}, { ...issue(), state: 'other' }, { ...issue(), risk: null }]) {
    assert.equal(deriveStatus(input, [], fixture.now), '未知');
  }
  for (const prs of [undefined, null, {}, [null], [{}], [pr({ merged: 1 })], [pr({ head_sha: '' })],
    [pr({ state: 'other' })], [pr({ qa: 'other' })], [pr({ scope: null })], [pr({ tested_commit: 123 })]]) {
    assert.equal(deriveStatus(issue(), prs, fixture.now), '未知');
  }
  for (const date of [undefined, null, 0, 'invalid', '2026-02-30T00:00:00Z', '2026-10-22', '2026-10-22T00:00:00']) {
    assert.equal(deriveStatus(issue(), [], date), '未知');
    assert.equal(derive(issue({ created_at: date })), '未知');
  }
  assert.equal(deriveStatus(issue({ state: 'closed' }), null, fixture.now), '已完成');
  assert.equal(deriveStatus(issue(), []), '未知');
});
