import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deriveStatus } from '../scripts/derive-status.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/derive-status.json', import.meta.url)));
const issue = (patch = {}) => ({ ...fixture.issue, ...patch });
const pr = (patch = {}) => ({ ...fixture.pr, ...patch });
const derive = (i = issue(), prs = [], now = fixture.now) => deriveStatus(i, prs, now);

test("Given 高风险 open PR、`qa='PASS'`、`tested_commit` 为 1–6 位十六进制（如 `'8'`、`'abc'`），When 推导，Then 返回 `待质检`。", () => {
  for (const tested_commit of ['8', 'ab', 'abc', 'abcd', 'abcde', 'abcdef']) {
    const head_sha = tested_commit.padEnd(40, '0');
    assert.equal(derive(issue({ risk: '高' }), [pr({ qa: 'PASS', head_sha, tested_commit })]), '待质检');
  }
});

test('Given 同样输入但 `tested_commit` 为 7 位及以上且为 head 前缀，When 推导，Then 返回 `待合并`。', () => {
  const head = 'abcdef1234567890abcdef1234567890abcdef12';
  for (let length = 7; length <= 40; length++) {
    for (const [head_sha, tested_commit] of [
      [head, head.slice(0, length).toUpperCase()],
      [head.toUpperCase(), head.slice(0, length)],
    ]) {
      assert.equal(derive(issue({ risk: '高' }), [pr({ qa: 'PASS', head_sha, tested_commit })]), '待合并');
    }
  }
});

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
  assert.equal(derive(issue({ risk: '高' }), [pr({ qa: 'PASS', tested_commit: 'abcdef1' })]), '待合并');
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
  const ready = pr({ qa: 'PASS', tested_commit: 'abcdef1' });
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

test('离线隔离环境中加载纯函数，无网络、进程或文件系统能力', () => {
  const child = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { createContext, SourceTextModule } from 'node:vm';
    import assert from 'node:assert/strict';
    const source = readFileSync(new URL('./scripts/derive-status.mjs', import.meta.url), 'utf8');
    const fixture = JSON.parse(readFileSync(new URL('./test/fixtures/derive-status.json', import.meta.url)));
    const context = createContext({});
    const module = new SourceTextModule(source, { context });
    await module.link(() => { throw new Error('禁止外部模块'); });
    await module.evaluate({ timeout: 1000 });
    assert.equal(module.namespace.deriveStatus(fixture.issue, [fixture.pr], fixture.now), '待合并');
  `], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});
