import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { collectFacts } from '../scripts/collect.mjs';

const nowIso = '2026-10-22T00:00:00.000Z';
const manifest = { projects: [{ id: 'hac-flow', repo: 'zwmhua2-lab2/HAC-Flow' },
  { id: 'marketpulse', repo: 'zwmhua2-lab2/MarketPulse-AI' }] };
const issue = { number: 1, title: 'Issue', body: '原始正文', state: 'open',
  created_at: nowIso, updated_at: nowIso, closed_at: null, html_url: 'https://github.com/a/b/issues/1' };
const pr = { ...issue, number: 2, title: 'PR', body: 'PR 正文', merged_at: null,
  head: { sha: 'ABCDEF1234567890abcdef1234567890abcdef1234' } };
const pages = () => [[issue], [pr], [], []];
const response = (data, status = 200) => ({ status, json: async () => data });
function harness(data = pages()) {
  const calls = [];
  return { calls, fetchFn: async (url, options) => {
    calls.push({ url, options });
    const next = data.shift();
    if (next instanceof Error) throw next;
    return next && !Array.isArray(next) && 'status' in next ? next : response(next);
  } };
}
const collect = (h, input = manifest, extra = {}) => collectFacts(input, { nowIso, fetchFn: h.fetchFn, ...extra });
const fails = (promise) => assert.rejects(promise, (e) =>
  e instanceof Error && e.code === 'COLLECT_ERROR' && e.exitCode === 1);

test("Given 清单包含 `hac-flow` 与 `marketpulse`、四组有效短页 mock、固定 `nowIso='2026-10-22T00:00:00.000Z'`，When `collectFacts`，Then 返回 `as_of` 精确等于该值、`projects.length===2` 且两个 `id` 依次为 `hac-flow`、`marketpulse`；`issues/prs` 按完整 schema 深度一致，不含 `age_seconds` 或治理推断字段。", async () => {
  assert.deepEqual(await collect(harness()), { as_of: nowIso, projects: [
    { id: 'hac-flow', issues: [issue], prs: [pr] }, { id: 'marketpulse', issues: [], prs: [] },
  ] });
});
test("Given `/issues` 包含一条普通 Issue 与一条含 `pull_request` 标记的占位项、`/pulls` 包含对应 PR，When 采集，Then `issues.length===1`、`prs.length===1`，PR 不被重复算作 Issue。", async () => {
  const out = await collect(harness([[issue, { pull_request: {} }], [pr], [], []]));
  assert.equal(out.projects[0].issues.length, 1);
  assert.equal(out.projects[0].prs.length, 1);
});
test("Given 一页正好 100 条，第二页 1 条，When 采集，Then 发出 `page=1` 和 `page=2` 两次请求，输出 101 条；不得默默截断。", async () => {
  for (const endpoint of ['issues', 'pulls']) {
    const item = endpoint === 'issues' ? issue : pr;
    const rows = Array.from({ length: 100 }, (_, n) => ({ ...item, number: n + 1 }));
    const h = harness(endpoint === 'issues' ? [rows, [item], [], [], []] : [[], rows, [item], [], []]);
    const out = await collect(h);
    assert.equal(out.projects[0][endpoint === 'issues' ? 'issues' : 'prs'].length, 101);
    assert.deepEqual(h.calls.filter(c => new URL(c.url).pathname.endsWith('/' + endpoint))
      .slice(0, 2).map(c => new URL(c.url).searchParams.get('page')), ['1', '2']);
  }
});
test("Given 任一请求返回 403 或 429，When 采集，Then 每种情况均抛 `code='COLLECT_ERROR',exitCode=1`；同 URL 请求次数严格为 1，不重试。", async () => {
  for (const status of [403, 429]) {
    const h = harness([response(null, status)]);
    await fails(collect(h));
    assert.equal(h.calls.length, 1);
  }
});
test("Given 假 fetch 永不 resolve（且忽略 abort）或 `response.json()` 永不 resolve，When 手工触发注入计时器 5000ms 回调，Then 抛 `COLLECT_ERROR`，其 `exitCode===1`，对应 `AbortSignal.aborted===true`，没有真实 5 秒等待。", async () => {
  for (const stalledBody of [false, true]) {
    let callback, signal, handle;
    const cleared = [];
    const pending = collectFacts(manifest, { nowIso,
      setTimer: (fn, ms) => { assert.equal(ms, 5000); callback = fn; return handle = {}; },
      clearTimer: (id) => cleared.push(id),
      fetchFn: async (_url, options) => {
        signal = options.signal;
        return stalledBody ? { status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
      } });
    await Promise.resolve(); await Promise.resolve();
    callback();
    await fails(pending);
    assert.equal(signal.aborted, true);
    assert.deepEqual(cleared, [handle]);
  }
});
test("Given HTTP 200 但返回对象而非数组、条目缺少 `head.sha`、字段类型非法或 JSON 解析拒绝，When 分别采集，Then 全部为 `COLLECT_ERROR`，不产生成功数据，不填默认值。", async () => {
  const cases = [[{}], [[issue], [{ ...pr, head: {} }]], [[{ ...issue, number: '1' }]],
    [{ status: 200, json: async () => { throw new SyntaxError('bad JSON'); } }]];
  for (const data of cases) await fails(collect(harness(data)));
  for (const [item, fields] of [[issue, Object.keys(issue)], [pr, Object.keys(pr)]]) {
    for (const field of fields) {
      const bad = { ...item }; delete bad[field];
      await fails(collect(harness(item === issue ? [[bad]] : [[issue], [bad]])));
    }
  }
  for (const patch of [{ state: 'other' }, { body: 0 }, { created_at: '2026-02-30T00:00:00Z' },
    { updated_at: 'invalid' }, { closed_at: false }, { number: 0 }, { title: null }, { html_url: 5 }])
    await fails(collect(harness([[{ ...issue, ...patch }]])));
  for (const patch of [{ head: { sha: 'a'.repeat(39) } }, { head: { sha: 'g'.repeat(40) } },
    { merged_at: false }]) await fails(collect(harness([[issue], [{ ...pr, ...patch }]])));
});
test("Given 第一项目成功、第二项目返回 HTTP 500，When 采集，Then 整体抛 `COLLECT_ERROR` 且 `exitCode===1`，不返回第一项目的部分快照。", async () => {
  const h = harness([[issue], [pr], response(null, 500)]);
  let returned;
  await fails(collect(h).then(out => { returned = out; }));
  assert.equal(returned, undefined);
  assert.equal(h.calls.length, 3);
});
test("Given `manifest.projects=[]` 或 `repo` 不合法，When 采集，Then 在调用 fetch 0 次的情况下抛 `COLLECT_ERROR`；Given 合法清单及假 fetch，When 采集，Then所有请求方法均为 GET，主机仅 `api.github.com`，且无 Authorization/Cookie/token，也未请求 K 线域名。", async () => {
  for (const input of [{ projects: [] }, { projects: [{ id: 'x', repo: '../evil' }] },
    null, {}, { projects: [...manifest.projects, manifest.projects[0]] },
    { projects: [manifest.projects[0], manifest.projects[0]] },
    { projects: [{ id: ' ', repo: 'a/b' }] }, { projects: [{ id: 'x', repo: 'a/b?token=x' }] }]) {
    const h = harness(); await fails(collect(h, input)); assert.equal(h.calls.length, 0);
  }
  for (const time of [undefined, 'invalid', '2026-02-30T00:00:00Z', '2026-10-22T00:00:00']) {
    const h = harness(); await fails(collect(h, manifest, { nowIso: time })); assert.equal(h.calls.length, 0);
  }
  const h = harness(); await collect(h);
  assert.equal(h.calls.length, 4);
  for (const { url, options } of h.calls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(parsed.search, '?state=all&per_page=100&page=1');
    assert.deepEqual(Object.keys(options).sort(), ['credentials', 'method', 'redirect', 'signal']);
  }
});
test("Given 含各自非空 `body` 与实际 `null` 字段的 API fixture，When 采集，Then原值逐字段保留；输出无 `risk/qa/scope/tested_commit/merged/执行中` 字段，原始 manifest 与 mock 输入对象深度不变。", async () => {
  const data = [[{ ...issue, risk: '低', qa: 'PASS' }], [{ ...pr, merged: false }], [], []];
  const before = structuredClone({ manifest, data });
  const h = harness([...data]); const out = await collect(h);
  assert.deepEqual(out.projects[0], { id: 'hac-flow', issues: [issue], prs: [pr] });
  assert.deepEqual({ manifest, data }, before);
  assert.doesNotMatch(JSON.stringify(out), /"(?:risk|qa|scope|tested_commit|merged|age_seconds|执行中)":/);
});
test("Given 本卡提交文件，When `node --test`，Then 本卡全部断言通过，进程退出码 0；Given 模拟 HTTP 错误，When 捕获 `collectFacts` 异常，Then `code='COLLECT_ERROR'` 且 `exitCode===1`；不把 B 卡尚未实施的进程退出或原子写入宣称为已验证。", async () => {
  const source = readFileSync(new URL('../scripts/collect.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(?:import|require|process)\b|node:|GITHUB_TOKEN|Authorization|Cookie/);
  const ids = [], cleared = [];
  await collect(harness(), manifest, { setTimer: (_fn, ms) => {
    assert.equal(ms, 5000); const id = {}; ids.push(id); return id;
  }, clearTimer: id => cleared.push(id) });
  assert.equal(ids.length, 4); assert.deepEqual(cleared, ids);
  for (const data of [[response(null, 500)], [new Error('network')], [[], [pr], [], {}]])
    await fails(collect(harness(data)));
});
