import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyPr } from '../scripts/verify-qa.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const pr = { state: 'open', head: { sha: a }, additions: 10, deletions: 10 };
const qa = (sha = a, extra = {}) => ({ id: 1, author_association: 'MEMBER',
  created_at: '2026-10-22T00:00:00Z', body: `QA 结论：PASS\n被测 commit：${sha}`, ...extra });
async function run({ pull = pr, comments = [[qa()]], files = [[{ filename: 'scripts/example.mjs' }]],
  error, raw, input = {} } = {}) {
  const calls = [], values = [pull, comments, files];
  const result = await verifyPr({ owner: 'zwmhua2-lab2', repo: 'HAC-Workbench', prNumber: 11,
    ghFn: async args => { calls.push(args); if (error) throw error;
      return raw ?? JSON.stringify(values.shift()); }, ...input });
  return { ...result, calls };
}
function blocks(report, flags) {
  for (const [i, label] of ['QA SHA 不匹配', '总行数 >300', 'PR 非 OPEN'].entries())
    assert.ok(report.includes(`${label}：${flags[i] ? '是' : '否'}`), report);
}

test('Given `OPEN` PR、总行数 20、有效 QA 被测 SHA `a` 重复 40 位而 head SHA `b` 重复 40 位，When `verifyPr`，Then `exitCode===1` 且报告第一类阻断「是」，另外两项「否」。', async () => {
  const out = await run({ pull: { ...pr, head: { sha: b } } });
  assert.equal(out.exitCode, 1); blocks(out.report, [true, false, false]);
});
test('Given `OPEN` PR、有效 QA SHA 与 head 相等且 `additions=200,deletions=101`，When 推导，Then `exitCode===1` 且行数阻断「是」、总行数 `301`；Given 相同但 `deletions=100`，Then 总行数 `300`、`exitCode===0`。', async () => {
  for (const deletions of [101, 100]) {
    const out = await run({ pull: { ...pr, additions: 200, deletions } });
    assert.equal(out.exitCode, deletions === 101 ? 1 : 0);
    assert.ok(out.report.includes(`总行数：${200 + deletions}`));
    blocks(out.report, [false, deletions === 101, false]);
  }
});
test("Given PR `state='closed'`、QA SHA 一致、总行数 20，When 推导，Then `exitCode===1` 且 PR 非 OPEN 阻断「是」。", async () => {
  const out = await run({ pull: { ...pr, state: 'closed' } });
  assert.equal(out.exitCode, 1); blocks(out.report, [false, false, true]);
  assert.match(out.report, /PR state：CLOSED/);
});
test('Given `OPEN`、行数 300、QA SHA 一致、无红牌，When 推导，Then `exitCode===0` 且三类阻断均「否」，并明确报告 0 不表示 QA PASS。', async () => {
  const out = await run({ pull: { ...pr, additions: 200, deletions: 100 } });
  assert.equal(out.exitCode, 0); blocks(out.report, [false, false, false]);
  for (const text of ['PR #11', 'PR state：OPEN', `head SHA：${a}`, 'QA 结论：PASS',
    `QA 被测 commit：${a}`, '新增行数：200', '删除行数：100', '总行数：300',
    'scripts/example.mjs', '红牌提示：无', '最终退出码：0', '仅机械检查未阻断，不等于 QA PASS/允许合并'])
    assert.ok(out.report.includes(text), text);
});
test('Given 缺失评论、评论作者关联 `NONE` 或两条评论各只含 QA/commit 之一，When 分别推导，Then 每次 `exitCode===0`、报告含「无有效 QA 结论」，不得从两条拼出有效 QA；Given仅 39/41 位 SHA，Then 同样没有有效 QA。', async () => {
  const invalid = [[], [qa(a, { author_association: 'NONE' })],
    [qa(a, { body: 'QA 结论：PASS' }), qa(a, { body: `被测 commit：${a}` })],
    ...['a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), a + 'g'].map(sha => [qa(sha)]),
    ...['2026-02-30T00:00:00Z', '2026-10-22T00:00:00.000Z', '2026-10-22T00:00:00+00:00',
      'invalid'].map(created_at => [qa(a, { created_at })]),
    [null, {}, qa(a, { id: '1' }), qa(a, { body: null }), qa(a, { id: -1 })]];
  for (const comments of invalid) {
    const out = await run({ comments: [comments] });
    assert.equal(out.exitCode, 0); assert.match(out.report, /无有效 QA 结论／需人工判断/);
    blocks(out.report, [false, false, false]);
  }
});
test('Given 可信 `MEMBER` 评论同时包含 `QA 结论：FAIL` 与匹配的 40 位 `被测 commit`，When 推导，Then `exitCode===0`、报告含 `FAIL` 与「需人工判断」，三类机械阻断均「否」。', async () => {
  const out = await run({ comments: [[qa(a, { body: `QA 结论：FAIL\n被测 commit：${a}` })]] });
  assert.equal(out.exitCode, 0); assert.match(out.report, /QA=FAIL（需人工判断）/);
  blocks(out.report, [false, false, false]);
});
test('Given改动文件包含 `ARCHITECTURE.md`、`.github/workflows/test.yml`，When 推导，Then `exitCode===0`、完整文件列表包含两路径且红牌提示含「需人工确认已获架构批准」。', async () => {
  const paths = ['ARCHITECTURE.md', '.github/workflows/test.yml', 'AGENTS.md', 'vendor/parser.mjs',
    'projects.json', 'package.json', 'package-lock.json', 'test/config.mjs', 'vitest.config.ts', 'src/package.json'];
  const plain = ['docs/ARCHITECTURE.md', '.github-other/x', 'vendors/x'];
  const out = await run({ files: [paths.map(filename => ({ filename })), [], plain.map(filename => ({ filename }))] });
  assert.equal(out.exitCode, 0);
  for (const path of [...paths, ...plain]) assert.ok(out.report.includes(`- ${path}`));
  for (const path of paths.filter(path => path !== 'test/config.mjs'))
    assert.ok(out.report.includes(`${path}：需人工确认已获架构批准`), path);
  for (const path of plain) assert.ok(!out.report.includes(`${path}：需人工确认已获架构批准`));
});
test('Given 可信较新评论出现在数组第一位、较旧的在最后一位（两者不同 SHA）且两者均有效，When 推导，Then 按 `created_at` 最新者的 SHA 判定，不受 API 返回顺序影响；Given评论分页分散在两页，Then仍选择全体最新有效者。', async () => {
  const newer = qa(a.toUpperCase(), { id: 2, author_association: 'OWNER', created_at: '2026-10-23T00:00:00Z' });
  const older = qa(b), tie = qa(b, { ...newer, body: qa(b).body, id: 1 });
  const untrusted = qa(b, { author_association: 'NONE', created_at: '2026-10-24T00:00:00Z' });
  for (const comments of [[[newer, older]], [[older], [], [untrusted, newer]], [[tie, newer]], [[newer, tie]]]) {
    const out = await run({ comments }); assert.equal(out.exitCode, 0);
    assert.ok(out.report.includes(`QA 被测 commit：${a.toUpperCase()}`));
  }
  const out = await run({ comments: [[qa(b, { author_association: 'COLLABORATOR' })]],
    pull: { ...pr, state: 'closed', additions: 301 } });
  assert.equal(out.exitCode, 1); blocks(out.report, [true, true, true]);
});
test('Given `ghFn` 抛未登录/网络错误、返回非法 JSON、PR 数据缺 `head.sha` 或 PR 不存在，When 分别推导，Then 每种 `exitCode===2`、报告「工具或环境错误」且不报告机械阻断通过。', async () => {
  const cases = ['未登录', '网络错误', '404', 'ENOENT', '403', '429'].map(message => ({ error: new Error(message) }));
  cases.push({ raw: '{' }, { pull: { ...pr, head: {} } }, { pull: null },
    ...[{ head: { sha: 'g'.repeat(40) } }, { state: 'merged' }, { additions: -1 },
      { deletions: 1.5 }, { additions: '10' }].map(patch => ({ pull: { ...pr, ...patch } })),
    { comments: {} }, { comments: [null] }, { comments: [qa()] },
    { files: {} }, { files: [[{}]] }, { files: [[null]] });
  for (const options of cases) {
    const out = await run(options); assert.equal(out.exitCode, 2);
    assert.match(out.report, /工具或环境错误/); assert.doesNotMatch(out.report, /仅机械检查未阻断/);
    assert.doesNotMatch(out.report, /(?:QA SHA 不匹配|总行数 >300|PR 非 OPEN)：否/);
    assert.ok(out.calls.length <= 3);
  }
  for (const input of [{ owner: '' }, { owner: '-bad' }, { repo: '../x' }, { repo: '.' },
    { prNumber: 0 }, { prNumber: '11' }, { prNumber: 1.5 }, { ghFn: null }]) {
    const out = await run({ input }); assert.equal(out.exitCode, 2); assert.equal(out.calls.length, 0);
  }
});
test('Given 注入假 `ghFn`，When `node --test` 执行本卡测试，Then 不启动真实 `gh`、不联网、不写文件，全部 GWT 断言通过且测试命令退出码 0；Given源码与 PR diff，When Human 审查，Then 仅白名单文件改动、≤300 行、零新增依赖。', async () => {
  const out = await run(); assert.equal(out.exitCode, 0);
  assert.deepEqual(out.calls, [
    ['api', '--method', 'GET', 'repos/zwmhua2-lab2/HAC-Workbench/pulls/11'],
    ['api', '--method', 'GET', 'repos/zwmhua2-lab2/HAC-Workbench/issues/11/comments?per_page=100', '--paginate', '--slurp'],
    ['api', '--method', 'GET', 'repos/zwmhua2-lab2/HAC-Workbench/pulls/11/files?per_page=100', '--paginate', '--slurp'],
  ]);
  const source = readFileSync(new URL('../scripts/verify-qa.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /process\.env|writeFile|appendFile|mkdir|process\.exit\(|fetch\(/);
  assert.match(source, /execFile\('gh', args,/); assert.match(source, /shell:\s*false/);
  assert.match(source, /timeout:\s*5000/);
});
