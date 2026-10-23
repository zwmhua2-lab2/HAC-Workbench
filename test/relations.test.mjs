import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRelations } from '../scripts/relations.mjs';

const issue = (number) => ({ number, title: 't', body: null, state: 'closed' });
const pr = (number, body) => ({ number, body, state: 'open' });
const issuesOf = (...numbers) => numbers.map(issue);
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
};

test('Given issues 为 #6、#7、PR #9 的正文有独立行 `Closes #6`、`Fixes: #7`、`Resolves #6, closes #7`，When `buildRelations`，Then 返回 `relations=[{issue:6,prs:[9]},{issue:7,prs:[9]}]`、`unmatchedPrCount=0`。', () => {
  const result = buildRelations(issuesOf(6, 7), [pr(9, 'Closes #6\nFixes: #7\nResolves #6, closes #7')]);
  assert.deepEqual(result, { relations: [{ issue: 6, prs: [9] }, { issue: 7, prs: [9] }], unmatchedPrCount: 0 });
});

test('Given issues #6/#7、PR #9 的唯一正文行 `Closes #6, #7`，When 解析，Then `relations=[]`、`unmatchedPrCount=1`，不得部分关联 #6。', () => {
  const result = buildRelations(issuesOf(6, 7), [pr(9, 'Closes #6, #7')]);
  assert.deepEqual(result, { relations: [], unmatchedPrCount: 1 });
});

test('Given issues #6/#99、PR #9 的正文先以三个反引号围栏包含 `Closes #99`、又以三个波浪线围栏包含 `Closes #99`，围栏外独立行 `Closes #6`，When 解析，Then 只返回 `[{issue:6,prs:[9]}]`，不关联 #99；Given 波浪线围栏内出现三个反引号及其后 `Closes #99`，Then仍不关联 #99。', () => {
  const body = ['```', 'Closes #99', '```', '~~~', 'Closes #99', '~~~', 'Closes #6'].join('\n');
  assert.deepEqual(buildRelations(issuesOf(6, 99), [pr(9, body)]),
    { relations: [{ issue: 6, prs: [9] }], unmatchedPrCount: 0 });

  const nested = ['~~~', '```', 'Closes #99', '```', '~~~'].join('\n');
  assert.deepEqual(buildRelations(issuesOf(6, 99), [pr(9, nested)]),
    { relations: [], unmatchedPrCount: 1 });
});

test('Given issues #6/#97/#98、PR #9 正文有 `> Closes #98`、`示例：Closes #97` 与独立行 `Closes #6`，When 解析，Then仅关联 #6。', () => {
  const body = ['> Closes #98', '示例：Closes #97', 'Closes #6'].join('\n');
  assert.deepEqual(buildRelations(issuesOf(6, 97, 98), [pr(9, body)]),
    { relations: [{ issue: 6, prs: [9] }], unmatchedPrCount: 0 });
});

test('Given issues=[{number:6}]，prs 按 #12 再 #9 输入且 body 均为 `Closes #6`，When 解析，Then 返回 `relations=[{issue:6,prs:[9,12]}]`；交换输入顺序结果不变，不丢第二个 PR。', () => {
  const forward = buildRelations(issuesOf(6), [pr(12, 'Closes #6'), pr(9, 'Closes #6')]);
  const reverse = buildRelations(issuesOf(6), [pr(9, 'Closes #6'), pr(12, 'Closes #6')]);
  assert.deepEqual(forward, { relations: [{ issue: 6, prs: [9, 12] }], unmatchedPrCount: 0 });
  assert.deepEqual(reverse, forward);
});

test('Given issues 只有 #6，PR #9 只写 `Closes #7`，When 解析，Then `relations=[]`、`unmatchedPrCount=1`；Given PR #9 写 `Closes #6, fixes #7`，Then `relations=[{issue:6,prs:[9]}]`、计数 0。', () => {
  assert.deepEqual(buildRelations(issuesOf(6), [pr(9, 'Closes #7')]),
    { relations: [], unmatchedPrCount: 1 });
  assert.deepEqual(buildRelations(issuesOf(6), [pr(9, 'Closes #6, fixes #7')]),
    { relations: [{ issue: 6, prs: [9] }], unmatchedPrCount: 0 });
});

test('Given issues #6，PR #9 的正文依次为 `other/repo#6`、`Closes #0`、`Closes #-1`、`Closes #01`、`Closes #6.` 或 `Closes # 6`，When 对每种输入单独解析，Then 均 `relations=[]`、`unmatchedPrCount=1`；Given `CLOSES #6`，Then关联 #6。', () => {
  for (const body of ['other/repo#6', 'Closes #0', 'Closes #-1', 'Closes #01', 'Closes #6.', 'Closes # 6']) {
    assert.deepEqual(buildRelations(issuesOf(6), [pr(9, body)]),
      { relations: [], unmatchedPrCount: 1 }, body);
  }
  assert.deepEqual(buildRelations(issuesOf(6), [pr(9, 'CLOSES #6')]),
    { relations: [{ issue: 6, prs: [9] }], unmatchedPrCount: 0 });
});

test('Given PR body 为 `null`、空串、数字及普通非字符串，When 分别解析，Then均不关联且各 `unmatchedPrCount=1`；Given `issues=[]`、`prs=[]`，Then `{relations:[],unmatchedPrCount:0}`；Given `issues=[]`、prs 中只有 #9，Then计数 1。', () => {
  for (const body of [null, '', 42, { a: 1 }, undefined]) {
    assert.deepEqual(buildRelations(issuesOf(6), [pr(9, body)]),
      { relations: [], unmatchedPrCount: 1 }, String(body));
  }
  assert.deepEqual(buildRelations([], []), { relations: [], unmatchedPrCount: 0 });
  assert.deepEqual(buildRelations([], [pr(9, 'Closes #6')]), { relations: [], unmatchedPrCount: 1 });
});

test('Given 深冻结的 issues/prs 及重复编号项，When 两次 `buildRelations` 并交换数组顺序，Then输出深度相等、升序去重、入参前后字节/结构不变，函数无网络/文件 IO 或跨调用缓存；Given `issues` 或 `prs` 非数组或包含非法编号，Then 抛 `TypeError`。', () => {
  const issues = freeze(issuesOf(6, 7));
  const prs = freeze([pr(12, 'Closes #6'), pr(9, 'Closes #7'), pr(12, 'Closes #7')]);
  const first = buildRelations(issues, prs);
  const second = buildRelations(issues, prs);
  assert.deepEqual(first, second);
  assert.deepEqual(first, { relations: [{ issue: 6, prs: [12] }, { issue: 7, prs: [9, 12] }], unmatchedPrCount: 0 });
  assert.deepEqual(issues, issuesOf(6, 7));
  assert.deepEqual(prs, [pr(12, 'Closes #6'), pr(9, 'Closes #7'), pr(12, 'Closes #7')]);
  assert.equal(first.unmatchedPrCount, 0);

  assert.throws(() => buildRelations('x', []), TypeError);
  assert.throws(() => buildRelations([], 'x'), TypeError);
  assert.throws(() => buildRelations([{ number: 0 }], []), TypeError);
  assert.throws(() => buildRelations([{ number: 1.5 }], []), TypeError);
  assert.throws(() => buildRelations([], [{ number: 0, body: '' }]), TypeError);
  assert.throws(() => buildRelations([null], []), TypeError);
});

test('Given 本卡测试文件与 fixture 均已提交，When 执行 `node --test`，Then 本卡与现有测试全部通过、退出 0；Given一条错误断言，Then测试退出非 0；Given PR diff，Then仅白名单文件变化、总改动（含测试）≤300 行且无新增依赖。', () => {
  const source = readFileSync(new URL('../scripts/relations.mjs', import.meta.url), 'utf8');
  assert.equal(/from ['"](?!node:)/.test(source), false);
  assert.equal(/require\(/.test(source), false);
  assert.equal(/\bfetch\b|process\.exit|readFile|writeFile/.test(source), false);
  assert.equal(/console\./.test(source), false);
  assert.deepEqual(buildRelations(issuesOf(6), [pr(9, '```\nCloses #6\n```')]),
    { relations: [], unmatchedPrCount: 1 });
});
