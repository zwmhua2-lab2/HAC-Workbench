import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildRelations } from '../scripts/relations.mjs';

const pr = (number, body) => ({ number, body });
const empty = unmatchedPrCount => ({ relations: [], unmatchedPrCount });
const linked = (...rows) => ({
  relations: rows.map(([issue, prs]) => ({ issue, prs })), unmatchedPrCount: 0,
});
const check = (numbers, prs, expected) =>
  assert.deepEqual(buildRelations(numbers.map(number => ({ number })), prs), expected);

test("Given issues 为 #6、#7、PR #9 的正文有独立行 `Closes #6`、`Fixes: #7`、`Resolves #6, closes #7`，When `buildRelations`，Then 返回 `relations=[{issue:6,prs:[9]},{issue:7,prs:[9]}]`、`unmatchedPrCount=0`。", () => {
  check([6, 7], [pr(9, 'Closes #6\nFixes: #7\nResolves #6, closes #7')], linked([6, [9]], [7, [9]]));
});

test("Given issues #6/#7、PR #9 的唯一正文行 `Closes #6, #7`，When 解析，Then `relations=[]`、`unmatchedPrCount=1`，不得部分关联 #6。", () => {
  check([6, 7], [pr(9, 'Closes #6, #7')], empty(1));
});

test("Given issues #6/#99、PR #9 的正文先以三个反引号围栏包含 `Closes #99`、又以三个波浪线围栏包含 `Closes #99`，围栏外独立行 `Closes #6`，When 解析，Then 只返回 `[{issue:6,prs:[9]}]`，不关联 #99；Given 波浪线围栏内出现三个反引号及其后 `Closes #99`，Then仍不关联 #99。", () => {
  for (const body of [
    '```js\nCloses #99\n```\n~~~\nCloses #99\n~~~\nCloses #6',
    '~~~\n```\nCloses #99\n~~~\nCloses #6',
  ]) check([6, 99], [pr(9, body)], linked([6, [9]]));
});

test("Given issues #6/#97/#98、PR #9 正文有 `> Closes #98`、`示例：Closes #97` 与独立行 `Closes #6`，When 解析，Then仅关联 #6。", () => {
  check([6, 97, 98], [pr(9, '> Closes #98\n示例：Closes #97\nCloses #6')], linked([6, [9]]));
});

test("Given issues=[{number:6}]，prs 按 #12 再 #9 输入且 body 均为 `Closes #6`，When 解析，Then 返回 `relations=[{issue:6,prs:[9,12]}]`；交换输入顺序结果不变，不丢第二个 PR。", () => {
  const prs = [pr(12, 'Closes #6'), pr(9, 'Closes #6')];
  check([6], prs, linked([6, [9, 12]]));
  check([6], prs.toReversed(), linked([6, [9, 12]]));
});

test("Given issues 只有 #6，PR #9 只写 `Closes #7`，When 解析，Then `relations=[]`、`unmatchedPrCount=1`；Given PR #9 写 `Closes #6, fixes #7`，Then `relations=[{issue:6,prs:[9]}]`、计数 0。", () => {
  check([6], [pr(9, 'Closes #7')], empty(1));
  check([6], [pr(9, 'Closes #6, fixes #7')], linked([6, [9]]));
});

test("Given issues #6，PR #9 的正文依次为 `other/repo#6`、`Closes #0`、`Closes #-1`、`Closes #01`、`Closes #6.` 或 `Closes # 6`，When 对每种输入单独解析，Then 均 `relations=[]`、`unmatchedPrCount=1`；Given `CLOSES #6`，Then关联 #6。", () => {
  for (const body of ['other/repo#6', 'Closes #0', 'Closes #-1', 'Closes #01', 'Closes #6.', 'Closes # 6']) {
    check([6], [pr(9, body)], empty(1));
  }
  check([6], [pr(9, 'CLOSES #6')], linked([6, [9]]));
});

test("Given PR body 为 `null`、空串、数字及普通非字符串，When 分别解析，Then均不关联且各 `unmatchedPrCount=1`；Given `issues=[]`、`prs=[]`，Then `{relations:[],unmatchedPrCount:0}`；Given `issues=[]`、prs 中只有 #9，Then计数 1。", () => {
  for (const body of [null, '', 42, {}, [], undefined, true]) check([6], [pr(9, body)], empty(1));
  check([], [], empty(0));
  check([], [pr(9, 'Closes #6'), pr(9, null)], empty(1));
  check([6], [], empty(0));
});

test("Given 深冻结的 issues/prs 及重复编号项，When 两次 `buildRelations` 并交换数组顺序，Then输出深度相等、升序去重、入参前后字节/结构不变，函数无网络/文件 IO 或跨调用缓存；Given `issues` 或 `prs` 非数组或包含非法编号，Then 抛 `TypeError`。", () => {
  const issues = Object.freeze([7, 6, 6].map(number => Object.freeze({ number, body: 'PR #99' })));
  const prs = Object.freeze([
    pr(12, 'Closes #7'), pr(9, 'Closes #6'), pr(9, 'Closes #7'),
    pr(8, null), pr(8, ''), pr(12, null),
  ].map(Object.freeze));
  const before = structuredClone({ issues, prs });
  const expected = linked([6, [9]], [7, [9, 12]]);
  expected.unmatchedPrCount = 1;
  const first = buildRelations(issues, prs);
  assert.deepEqual(first, expected);
  assert.deepEqual(buildRelations(issues, prs), first);
  assert.deepEqual(buildRelations(issues.toReversed(), prs.toReversed()), first);
  assert.deepEqual({ issues, prs }, before);
  first.relations[0].prs.push(100);
  assert.deepEqual(buildRelations(issues, prs), expected);
  for (const bad of [null, {}, undefined, 1, '']) {
    assert.throws(() => buildRelations(bad, []), TypeError);
    assert.throws(() => buildRelations([], bad), TypeError);
  }
  for (const item of [null, [], 1, {}, ...[0, -1, 1.5, NaN, Infinity, '6', Number.MAX_SAFE_INTEGER + 1]
    .map(number => ({ number }))]) {
    assert.throws(() => buildRelations([item], []), TypeError);
    assert.throws(() => buildRelations([], [item]), TypeError);
  }
  assert.throws(() => buildRelations(Array(1), []), TypeError);
  assert.throws(() => buildRelations([], Array(1)), TypeError);
});

test("Given 本卡测试文件与 fixture 均已提交，When 执行 `node --test`，Then 本卡与现有测试全部通过、退出 0；Given一条错误断言，Then测试退出非 0；Given PR diff，Then仅白名单文件变化、总改动（含测试）≤300 行且无新增依赖。", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  if (process.env.RELATIONS_NEGATIVE_ASSERTION === '1') {
    assert.equal(buildRelations([], []).unmatchedPrCount, -1, '故意错误断言');
    return;
  }
  const negative = spawnSync(process.execPath, ['--test', '--test-name-pattern=^Given 本卡测试文件',
    import.meta.filename], { env: { ...env, RELATIONS_NEGATIVE_ASSERTION: '1' },
    encoding: 'utf8', timeout: 10000 });
  assert.ifError(negative.error);
  assert.notEqual(negative.status, 0);
  assert.match(negative.stdout + negative.stderr, /故意错误断言/);
  assert.match(negative.stdout + negative.stderr, /AssertionError/);
  const isolated = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { createContext, SourceTextModule } from 'node:vm';
    import assert from 'node:assert/strict';
    const source = readFileSync('./scripts/relations.mjs', 'utf8');
    const module = new SourceTextModule(source, { context: createContext({}) });
    await module.link(() => { throw new Error('禁止外部模块'); });
    await module.evaluate({ timeout: 1000 });
    const result = module.namespace.buildRelations([{number:6}], [{number:9,body:'Closes #6'}]);
    assert.equal(JSON.stringify(result), '{"relations":[{"issue":6,"prs":[9]}],"unmatchedPrCount":0}');
  `], { cwd: new URL('../', import.meta.url), env, encoding: 'utf8', timeout: 10000 });
  assert.ifError(isolated.error);
  assert.equal(isolated.status, 0, isolated.stdout + isolated.stderr);
});

test('契约边界：空白、围栏开关、安全整数及整行校验', () => {
  for (const body of [' \t-  Fixes:\t#6\t', 'Closes #6 ,\tresolves #7\t',
    '~~~js\r\nCloses #99\r\n~~~~\r\nCloses #6', '  ````js\nCloses #99\n```\nCloses #6']) {
    const expected = body.includes('resolves') ? linked([6, [9]], [7, [9]]) : linked([6, [9]]);
    check([6, 7, 99], [pr(9, body)], expected);
  }
  for (const body of ['-Closes #6', 'Closes:: #6', 'Closes#6', 'Closes #6, fixes other/repo#7',
    'Closes #6, fixes #0', 'Closes #6 extra', '~~~\nCloses #6', '```\n~~~\nCloses #6',
    ' \t> Closes #6', 'Closes #9007199254740992']) check([6], [pr(9, body)], empty(1));
  check([1, Number.MAX_SAFE_INTEGER], [pr(9, 'Closes #1, fixes #9007199254740991')],
    linked([1, [9]], [Number.MAX_SAFE_INTEGER, [9]]));
});
