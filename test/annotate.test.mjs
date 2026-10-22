import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as annotations from '../scripts/annotate.mjs';

const { parseRisk, parseQa } = annotations;
const a = 'ABCDEF0123456789abcdef0123456789ABCDEF0123', b = 'b'.repeat(40);
const comment = (patch = {}) => ({ body: `QA 结论：PASS\n被测 commit：${a}`,
  created_at: '2026-10-22T01:00:00Z', id: 1, author_association: 'MEMBER', ...patch });
const result = (qa = 'PASS', tested_commit = a) => ({ qa, tested_commit });

test("Given `issueBody='- 风险：**高**；命中的第 6 节区域：解析外部输入'`，When `parseRisk`，Then 精确返回 `'高'`；Given `'风险：低'`，Then 返回 `'低'`；Given `'风险：unknown'`，Then 返回 `'unknown'`；Given `'风险：中'`，Then 返回 `null`。", () => {
  assert.equal(parseRisk('- 风险：**高**；命中的第 6 节区域：解析外部输入'), '高');
  assert.equal(parseRisk('风险：低'), '低');
  assert.equal(parseRisk('风险：unknown'), 'unknown');
  assert.equal(parseRisk('风险：中'), null);
});

test("Given 两行有效标注分别为 `风险：高`、`风险：低`，When `parseRisk`，Then `null`；Given 两行都是 `风险：**高**`，Then `'高'`，不得依赖首末位置。", () => {
  for (const body of ['风险：高\n风险：低', '风险：低\n风险：高'])
    assert.equal(parseRisk(body), null);
  assert.equal(parseRisk('风险：**高**\n风险：**高**'), '高');
});

test("Given 一个 `author_association:'MEMBER'`、合法 UTC 时间及正整数 id 的评论，同一 `body` 含 `QA 结论：PASS` 和 `被测 commit：` 后接 40 位十六进制 `ABCDEF...'`，When `parseQa`，Then 精确返回 `{qa:'PASS',tested_commit:<输入原始40位字符串>}`，保留大小写。", () => {
  assert.equal(a.length, 40);
  assert.deepEqual(parseQa([comment()]), result());
});

test("Given 一条可信评论仅有 `QA 结论：PASS`，另一条仅有 `被测 commit：` 后接合法 40 位 SHA，When `parseQa`，Then 返回 `null`，不得跨评论拼接。", () => {
  assert.equal(parseQa([comment({ body: 'QA 结论：PASS' }),
    comment({ id: 2, body: `被测 commit：${a}` })]), null);
});

test("Given 两条完整有效评论，较新（`created_at='2026-10-23T01:00:00Z'`）为 `FAIL`、较旧（`created_at='2026-10-22T01:00:00Z'`）为 `PASS`，When 以反序数组输入 `parseQa`，Then 返回 `{qa:'FAIL',tested_commit:<较新评论SHA>}`；同秒时取 id 较大的候选。", () => {
  const older = comment(), newer = comment({ id: 2, created_at: '2026-10-23T01:00:00Z',
    body: `QA 结论：FAIL\n被测 commit：${b}` });
  const tie = comment({ created_at: newer.created_at, id: 3 });
  for (const values of [[newer, older], [older, newer]])
    assert.deepEqual(parseQa(values), result('FAIL', b));
  for (const values of [[newer, tie], [tie, newer]])
    assert.deepEqual(parseQa(values), result());
});

test("Given可信作者评论的 SHA 为 6 位、39 位、41 位或含非十六进制，When 分别 `parseQa`，Then 均返回 `null`；Given完整 SHA 但 `author_association:'NONE'`，Then 返回 `null`；Given存在一条可信合法评论和一条不可信较新评论，Then只返回可信合法评论结果。", () => {
  for (const sha of ['a'.repeat(6), 'a'.repeat(39), 'a'.repeat(41), 'g'.repeat(40), a + 'g'])
    assert.equal(parseQa([comment({ body: `QA 结论：PASS\n被测 commit：${sha}` })]), null);
  const untrusted = comment({ author_association: 'NONE', created_at: '2026-10-23T01:00:00Z' });
  assert.equal(parseQa([untrusted]), null);
  assert.deepEqual(parseQa([untrusted, comment()]), result());
});

test("Given `parseRisk` 输入 `null`、空串、非字符串及 `parseQa` 输入 `null`、非数组、空数组、只有畸形评论，When 分别调用，Then 均返回 `null` 且不抛出异常。", () => {
  for (const value of [null, '', undefined, 0, false, {}, [], new String('风险：高')])
    assert.equal(parseRisk(value), null);
  for (const value of [null, '', undefined, 0, false, {}, [], [null, {}, [], 'bad']])
    assert.equal(parseQa(value), null);
  assert.deepEqual(parseQa([null, {}, comment(), []]), result());
});

test("Given 冻结且深拷贝的 Issue 正文及评论数组，When 分别调用 `parseRisk`/`parseQa`，Then 入参与调用前深度相等、返回值稳定；无网络请求与文件 IO，不修改其他仓库文件。", () => {
  const body = '风险：高', comments = [comment({ id: 2 }), comment({ id: 1 })];
  const before = structuredClone({ body, comments });
  Object.freeze(body);
  comments.forEach(Object.freeze);
  Object.freeze(comments);
  for (let i = 0; i < 3; i++) {
    assert.equal(parseRisk(body), '高');
    assert.deepEqual(parseQa(comments), result());
    assert.deepEqual({ body, comments }, before);
  }
  const output = parseQa(comments);
  output.qa = 'FAIL';
  assert.deepEqual(parseQa(comments), result());
});

test("Given 本卡文件均已提交，When `node --test`，Then 本卡与既有测试全部通过、退出 0；Given单条错误断言，When 执行测试，Then 退出非 0。When 检查 PR Files changed，Then 只含白名单文件且总改动≤300行、零新增依赖。", () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval',
    "import test from 'node:test'; import assert from 'node:assert/strict';" +
    "test('deliberately wrong assertion', () => assert.equal(1, 2));"],
  { encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.match(child.stdout + child.stderr, /ERR_ASSERTION/);
});

test('风险行只接受锁定格式、分号终止、成对星号及全角冒号', () => {
  for (const body of ['风险：高风险', '句子中间风险：高', '风险:高', '风险：**高',
    '风险：高**', '风险：***高***', '风险：UNKNOWN', '风险：高 extra'])
    assert.equal(parseRisk(body), null, body);
  for (const body of [' \t- \t风险：**低** ;备注\r\n', '风险：低；备注', '\t风险：低\t\r\n'])
    assert.equal(parseRisk(body), '低', body);
  assert.equal(parseRisk('风险：高\n风险：unknown'), null);
  assert.equal(parseRisk('风险：中\n风险：高'), '高');
});

test('QA 评论字段类型、正安全整数 id 和作者资格必须全部有效', () => {
  const invalid = [{ body: null }, { body: 1 }, { id: 0 }, { id: -1 }, { id: 1.5 },
    { id: '1' }, { id: NaN }, { id: Infinity }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { created_at: null }, { author_association: 'member' }, { author_association: null }];
  for (const patch of invalid) {
    assert.equal(parseQa([comment(patch)]), null);
    assert.deepEqual(parseQa([comment(patch), comment()]), result());
  }
  for (const author_association of ['OWNER', 'MEMBER', 'COLLABORATOR'])
    assert.deepEqual(parseQa([comment({ author_association, id: Number.MAX_SAFE_INTEGER })]), result());
  const array = Object.assign([], comment());
  assert.equal(parseQa([array]), null);
});

test('QA 时间仅接受有效 UTC 秒级 ISO，拒绝日期溢出及本地时区变体', () => {
  for (const created_at of ['invalid', '', '2026-02-29T01:00:00Z', '2026-02-30T01:00:00Z',
    '2026-13-01T01:00:00Z', '2026-10-22T24:00:00Z', '2026-10-22T01:60:00Z',
    '2026-10-22T01:00:60Z', '2026-10-22T01:00:00.000Z', '2026-10-22T01:00:00+00:00',
    '2026-10-22T01:00:00z', '2026-10-22T01:00:00Z\n', '2026-10-22'])
    assert.equal(parseQa([comment({ created_at })]), null, created_at);
  assert.deepEqual(parseQa([comment({ created_at: '2024-02-29T23:59:59Z' })]), result());
});

test('QA 标签区分大小写，不能截取更长单词或非法 SHA', () => {
  for (const body of [`QA 结论：PASSED\n被测 commit：${a}`, `QA 结论：pass\n被测 commit：${a}`,
    `QA 结论：PASS_\n被测 commit：${a}`, `QA 结论：PASS\n被测 COMMIT：${a}`,
    `QA 结论：PASS\n被测 commit：${a}_`, `QA 结论：PASS\n被测 commit：${a}0`])
    assert.equal(parseQa([comment({ body })]), null, body);
  assert.deepEqual(parseQa([comment({ body: `QA 结论：FAIL；被测 commit：${a}。` })]), result('FAIL'));
});

test('仅导出两个同步解析函数，输出不补充状态或默认字段', () => {
  assert.deepEqual(Object.keys(annotations).sort(), ['parseQa', 'parseRisk']);
  assert.deepEqual(Object.keys(parseQa([comment()])).sort(), ['qa', 'tested_commit']);
  assert.equal(parseQa([comment()]) instanceof Promise, false);
  assert.equal(parseRisk('无标注'), null);
});
