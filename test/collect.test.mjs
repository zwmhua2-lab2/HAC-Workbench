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
  head: { sha: 'ABCDEF1234567890abcdef1234567890abcdef12' } };
const pages = () => [[issue], [pr], [], [], []];
const commentedPr = { ...pr, comments: [] };
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

const comment = { id: 1, body: 'QA 结论：PASS', created_at: '2026-10-22T12:34:56Z',
  author_association: 'COLLABORATOR' };
const commentPages = (...rows) => [[issue], [pr], ...rows, [], []];

test('Given 两个项目的 mock 各有 Issue/PR 且每 PR 返回合法评论，When collectFacts，Then 每 PR 都有 comments，且元素深度相等于四字段投影；旧有 PR 字段与 as_of、项目顺序不变。', async () => {
  const extra = { ...comment, user: {}, url: 'ignored', updated_at: nowIso };
  const prs = [pr, { ...pr, number: 3, state: 'closed' },
    { ...pr, number: 4, state: 'closed', merged_at: nowIso }];
  const h = harness([[issue], prs, [extra], [extra], [extra], [issue], [pr], [extra]]);
  assert.deepEqual(await collect(h), { as_of: nowIso, projects: manifest.projects.map(({ id }, i) =>
    ({ id, issues: [issue], prs: (i ? [pr] : prs).map(p => ({ ...p, comments: [comment] })) })) });
  assert.deepEqual(h.calls.map(c => new URL(c.url).pathname), manifest.projects.flatMap(({ repo }, i) =>
    ['issues', 'pulls', ...(i ? [2] : [2, 3, 4]).map(n => `issues/${n}/comments`)]
      .map(path => `/repos/${repo}/${path}`)));
});

test('Given PR #2 评论页只有 1 条或空数组，When 采集，Then 严格请求评论 page=1 一次，无 state=all，GET 且无凭据；空数组无第二页请求。', async () => {
  for (const rows of [[comment], []]) {
    const h = harness(commentPages(rows));
    assert.deepEqual((await collect(h)).projects[0].prs[0].comments, rows);
    const calls = h.calls.filter(c => c.url.includes('/comments'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://api.github.com/repos/${manifest.projects[0].repo}/issues/2/comments?per_page=100&page=1`);
    assert.deepEqual(calls[0].options, { method: 'GET', signal: calls[0].options.signal,
      credentials: 'omit', redirect: 'error' });
  }
});

test('Given 某 PR 评论第一页正好 100 条，第二页 1 条或空，When 采集，Then 必须访问两页，输出 101 或 100 条且次序/字段不变，不得截断。', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 }));
  for (const second of [[{ ...comment, id: 101 }], []]) {
    const h = harness(commentPages(first, second));
    assert.deepEqual((await collect(h)).projects[0].prs[0].comments, [...first, ...second]);
    assert.deepEqual(h.calls.filter(c => c.url.includes('/comments')).map(c => new URL(c.url).search),
      ['?per_page=100&page=1', '?per_page=100&page=2']);
  }
});

test('Given 合法 UTC 秒级评论及 COLLABORATOR、NONE 或空 author_association，When 采集，Then 精确保留字符串原值，不筛选可信角色。', async () => {
  for (const author_association of ['COLLABORATOR', 'NONE', '']) {
    const rows = [{ ...comment, author_association }, { ...comment, id: 2, body: '' }];
    const out = await collect(harness(commentPages(rows)));
    assert.deepEqual(out.projects[0].prs[0].comments, rows);
    assert.doesNotMatch(JSON.stringify(out), /"(?:qa|risk|scope|tested_commit)":/);
  }
});

test('Given 评论缺任一四字段或 id/body/author_association 非法，When 采集，Then 逐例抛 COLLECT_ERROR、exitCode=1，无部分返回。', async () => {
  const bad = Object.keys(comment).map(key => { const row = { ...comment }; delete row[key]; return row; });
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null]) bad.push({ ...comment, id });
  for (const body of [null, 1]) bad.push({ ...comment, body });
  for (const author_association of [null, 1, {}]) bad.push({ ...comment, author_association });
  for (const row of [...bad, null, [], 1]) await fails(collect(harness(commentPages([comment, row]))));
});

test('Given 评论 created_at 带毫秒、UTC 偏移、无 Z、无效日历日期或非字符串，When 采集，Then 逐例失败；合法秒级 UTC 接受，不改变 Issue/PR 时间口径。', async () => {
  for (const created_at of ['2026-10-22T12:34:56.000Z', '2026-10-22T12:34:56.1Z',
    '2026-10-22T12:34:56+00:00', '2026-10-22T12:34:56+08:00', '2026-10-22T12:34:56',
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-22T24:00:00Z', null, 1])
    await fails(collect(harness(commentPages([{ ...comment, created_at }]))));
  assert.deepEqual((await collect(harness(commentPages([comment])))).projects[0].prs[0].comments, [comment]);
});

test('Given 评论第一页 100 条，第二页 HTTP/网络/JSON/非数组/101 条失败，When 采集，Then 按 C1 整批失败且同 URL 不重试；请求或 json 挂起触发 5000ms 后 abort 并失败。', async () => {
  const first = Array.from({ length: 100 }, (_, i) => ({ ...comment, id: i + 1 }));
  for (const failure of [...[403, 429, 500].map(status => response(null, status)), new Error('network'),
    { status: 200, json: async () => { throw new SyntaxError('JSON'); } }, {}, [...first, comment]]) {
    const h = harness(commentPages(first, failure));
    await fails(collect(h));
    assert.equal(h.calls.length, 4);
    assert.equal(new Set(h.calls.map(c => c.url)).size, 4);
  }
  for (const stalledBody of [false, true]) {
    let fire, signal, notify;
    const started = new Promise(resolve => { notify = resolve; });
    const h = harness([[issue], [pr], first]);
    const pending = collect(h, manifest, {
      setTimer: (fn, ms) => { assert.equal(ms, 5000); fire = fn; return fn; }, clearTimer: () => {},
      fetchFn: async (url, options) => {
        if (!url.endsWith('/comments?per_page=100&page=2')) return h.fetchFn(url, options);
        signal = options.signal; notify();
        return stalledBody ? { status: 200, json: () => new Promise(() => {}) } : new Promise(() => {});
      } });
    await started; fire(); await fails(pending); assert.equal(signal.aborted, true);
  }
});

test('Given 第一项目评论成功、第二项目某 PR 评论失败，When 采集，Then 无任何成功快照返回，输入 fixture 与 manifest 不变。', async () => {
  const data = [[issue], [pr], [comment], [issue], [pr], response(null, 500)];
  const before = structuredClone({ manifest, data: data.slice(0, 5) });
  let returned;
  const h = harness([...data]);
  await fails(collect(h).then(value => { returned = value; }));
  assert.equal(returned, undefined); assert.equal(h.calls.length, 6);
  assert.deepEqual({ manifest, data: data.slice(0, 5) }, before);
});

test("Given 清单包含 `hac-flow` 与 `marketpulse`、四组有效短页 mock、固定 `nowIso='2026-10-22T00:00:00.000Z'`，When `collectFacts`，Then 返回 `as_of` 精确等于该值、`projects.length===2` 且两个 `id` 依次为 `hac-flow`、`marketpulse`；`issues/prs` 按完整 schema 深度一致，不含 `age_seconds` 或治理推断字段。", async () => {
  assert.deepEqual(await collect(harness()), { as_of: nowIso, projects: [
    { id: 'hac-flow', issues: [issue], prs: [commentedPr] }, { id: 'marketpulse', issues: [], prs: [] },
  ] });
});
test("Given `/issues` 包含一条普通 Issue 与一条含 `pull_request` 标记的占位项、`/pulls` 包含对应 PR，When 采集，Then `issues.length===1`、`prs.length===1`，PR 不被重复算作 Issue。", async () => {
  const out = await collect(harness([[issue, { pull_request: {} }], [pr], [], [], []]));
  assert.equal(out.projects[0].issues.length, 1);
  assert.equal(out.projects[0].prs.length, 1);
});
test("Given 一页正好 100 条，第二页 1 条，When 采集，Then 发出 `page=1` 和 `page=2` 两次请求，输出 101 条；不得默默截断。", async () => {
  for (const endpoint of ['issues', 'pulls']) {
    const item = endpoint === 'issues' ? issue : pr;
    const rows = Array.from({ length: 100 }, (_, n) => ({ ...item, number: n + 1 }));
    const h = harness(endpoint === 'issues' ? [rows, [item], [], [], []] : [[], rows, [item], ...Array.from({ length: 101 }, () => []), [], []]);
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
  const h = harness([[issue], [pr], [], response(null, 500)]);
  let returned;
  await fails(collect(h).then(out => { returned = out; }));
  assert.equal(returned, undefined);
  assert.equal(h.calls.length, 4);
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
  assert.equal(h.calls.length, 5);
  for (const { url, options } of h.calls) {
    const parsed = new URL(url);
    assert.equal(parsed.origin, 'https://api.github.com'); assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    assert.equal(parsed.search, parsed.pathname.endsWith('/comments')
      ? '?per_page=100&page=1' : '?state=all&per_page=100&page=1');
    assert.deepEqual(Object.keys(options).sort(), ['credentials', 'method', 'redirect', 'signal']);
  }
});
test("Given 含各自非空 `body` 与实际 `null` 字段的 API fixture，When 采集，Then原值逐字段保留；输出无 `risk/qa/scope/tested_commit/merged/执行中` 字段，原始 manifest 与 mock 输入对象深度不变。", async () => {
  const data = [[{ ...issue, risk: '低', qa: 'PASS' }], [{ ...pr, merged: false }], [], [], []];
  const before = structuredClone({ manifest, data });
  const h = harness([...data]); const out = await collect(h);
  assert.deepEqual(out.projects[0], { id: 'hac-flow', issues: [issue], prs: [commentedPr] });
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
  assert.equal(ids.length, 5); assert.deepEqual(cleared, ids);
  for (const data of [[response(null, 500)], [new Error('network')], [[], [pr], [], {}]])
    await fails(collect(harness(data)));
});
