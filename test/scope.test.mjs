import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as scope from '../scripts/scope.mjs';

const { classifyScope } = scope;
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/scope-issues.json', import.meta.url), 'utf8'));
const original = number => fixtures.find(item => item.issue === number).excerpt;
const tick = value => '\x60' + value + '\x60';
const section = (...lines) => ['## 允许修改', ...lines].join('\n');
const allow = (...paths) => section('- 允许：' + paths.map(tick).join('、'));
const check = (body, files, expected) => assert.equal(classifyScope(body, files), expected);

test("Given 真实 Issue #6 的 `## 允许修改` 原文节选（只含 `scripts/collect.mjs`、`test/collect.test.mjs`、`test/fixtures/**` 三项），When `classifyScope` 传入文件 `['scripts/collect.mjs','test/fixtures/sample.json']`，Then 精确返回 `'ok'`；再增加 `'scripts/other.mjs'`，Then `'violation'`。", () => {
  const files = ['scripts/collect.mjs', 'test/fixtures/sample.json'];
  check(original(6), files, 'ok');
  check(original(6), [...files, 'scripts/other.mjs'], 'violation');
});

test("Given Issue #13 的真实白名单 `scripts/annotate.mjs`、`test/annotate.test.mjs`、`test/fixtures/**`，When 输入两个脚本/测试白名单路径，Then `'ok'`；再加入 `scripts/collect.mjs`，Then `'violation'`。Given Issue #16 的真实白名单只有 `ARCHITECTURE.md`，When 文件列表仅此文件，Then `'ok'`；再加 `AGENTS.md`，Then `'violation'`（`ok` 不代表 C5 获批）。", () => {
  const files = ['scripts/annotate.mjs', 'test/annotate.test.mjs'];
  check(original(13), files, 'ok');
  check(original(13), [...files, 'scripts/collect.mjs'], 'violation');
  check(original(16), ['ARCHITECTURE.md'], 'ok');
  check(original(16), ['ARCHITECTURE.md', 'AGENTS.md'], 'violation');
});

test("Given `- 允许：`test/fixtures/**``，When 文件列表分别为 `['test/fixtures/a.json']` 与 `['test/fixtures/sub/a.json']`，Then 两次都返回 `'ok'`（零层与多层）；Given `- 允许：`scripts/*.mjs``，When `['scripts/x.mjs']`，Then `'ok'`；When `['scripts/sub/x.mjs']`，Then `'violation'`。", () => {
  for (const file of ['test/fixtures/a.json', 'test/fixtures/sub/a.json'])
    check(allow('test/fixtures/**'), [file], 'ok');
  check(allow('scripts/*.mjs'), ['scripts/x.mjs'], 'ok');
  check(allow('scripts/*.mjs'), ['scripts/sub/x.mjs'], 'violation');
  for (const file of ['x.mjs', 'sub/x.mjs', 'sub/deep/x.mjs'])
    check(allow('**/x.mjs'), [file], 'ok');
  check(allow('scripts/**/x.mjs'), ['scripts/x.mjs', 'scripts/sub/x.mjs'], 'ok');
  check(allow('scripts/x.mjs'), ['scripts/x.mjs.extra'], 'violation');
});

test("Given 正文仅在 ````` 或 `~~~` 围栏内出现 `## 允许修改`，或仅在行中引用该标题，When 传入任一非空文件列表，Then `null`；Given 围栏外存在一处精确标题及有效允许行且正文采用 CRLF，When 文件匹配，Then `'ok'`；Given 有效章节后出现同级 `## 审查` 及新允许行，When 只匹配后一章节路径，Then `'violation'`。", () => {
  const valid = allow('scripts/x.mjs'), files = ['scripts/x.mjs'];
  for (const fence of ['\x60\x60\x60', '~~~', '  \x60\x60\x60\x60js'])
    check(fence + '\n' + valid + '\n' + fence, files, null);
  for (const title of ['引用 ## 允许修改', ' ## 允许修改', '## 允许修改 ', '### 允许修改'])
    check(title + '\n- 允许：' + tick('scripts/x.mjs'), files, null);
  check(valid.replaceAll('\n', '\r\n'), files, 'ok');
  check(valid + '\n## 审查\n- 允许：' + tick('other.mjs'), ['other.mjs'], 'violation');
  check(valid + '\n~~~\n## 审查\n- 允许：' + tick('other.mjs') + '\n~~~',
    ['other.mjs'], 'violation');
  check('~~~\n\x60\x60\x60\n' + valid + '\n~~~', files, null);
  check('~~~\n' + valid + '\n~~~\n' + valid, files, 'ok');
});

test("Given 没有 `## 允许修改` 章节，When 调用，Then `null`；Given 正文出现两个围栏外同名章节、各自有效，When 调用，Then `null`（不可选首个/末个）。", () => {
  check('无白名单', ['x.mjs'], null);
  check(allow('x.mjs') + '\n' + allow('y.mjs'), ['x.mjs'], null);
  check(allow('x.mjs') + '\n## 其他\n' + allow('x.mjs'), ['x.mjs'], null);
});

test("Given 有 `## 允许修改` 但没有 `- 允许：` 行（只有 `- 禁止：` 或解释文字），When 调用，Then `null`；Given 有允许行但无成对反引号路径或反引号内容为空，When 调用，Then `null`；不得忽略空项后部分采信其他合法项。", () => {
  for (const line of ['- 禁止：' + tick('x.mjs'), '说明 ' + tick('x.mjs'),
    '- 允许：无路径', '- 允许：' + tick(''), '- 允许：' + tick('x.mjs') + '、' + tick(''),
    '- 允许：' + tick('x.mjs') + '、\x60unclosed']) {
    check(section(line), ['x.mjs'], null);
    check(section('- 允许：' + tick('x.mjs'), line), ['x.mjs'],
      line.startsWith('- 允许：') ? null : 'ok');
  }
});

test("Given 一条合法允许路径加任意一条 `scripts/x?.mjs`、`scripts/{a,b}.mjs` 或 `scripts/[ab].mjs`，When 输入原本符合合法路径的文件，Then 三种非法 glob 分别返回 `null`，而非 `ok` 或 `violation`。", () => {
  for (const bad of ['scripts/x?.mjs', 'scripts/{a,b}.mjs', 'scripts/[ab].mjs',
    'scripts/@(a|b).mjs', '!scripts/x.mjs', 'scripts/***/x.mjs']) {
    check(allow('scripts/x.mjs', bad), ['scripts/x.mjs'], null);
    check(allow('scripts/x.mjs', bad), ['outside.mjs'], null);
  }
});

test("Given `changedFiles=[]` 且白名单有效，When 调用，Then `null`；Given 缺失或错误类型的输入、数组内非法文件路径成员，When 调用，Then `null` 且无异常。", () => {
  const valid = allow('scripts/x.mjs');
  check(valid, [], null);
  for (const bad of [undefined, null, 42, false, {}, [], new String(valid)])
    check(bad, ['scripts/x.mjs'], null);
  for (const bad of [undefined, null, 42, false, {}, 'scripts/x.mjs'])
    check(valid, bad, null);
  for (const bad of [null, undefined, 1, {}, [], '', '/x.mjs', '../x.mjs',
    './x.mjs', 'a/../x.mjs', 'a//x.mjs', 'x/', 'C:/x.mjs', 'x\0.mjs']) {
    check(valid, ['scripts/x.mjs', bad], null);
    if (typeof bad === 'string') check(allow('scripts/x.mjs', bad), ['scripts/x.mjs'], null);
  }
  check(valid, Array(1), null);
  check(valid, ['outside.mjs', null], null);
  assert.doesNotThrow(() => classifyScope());
});

test("Given 多条 `- 允许：` 及同一行多条成对反引号项，When 每个改动文件命中不同允许项，Then `'ok'`；Given 在 `- 禁止：` 行出现额外反引号路径，When 只改该禁止路径，Then `'violation'`。", () => {
  const body = section('- 允许：' + tick('a.mjs') + '、' + tick('b.mjs'),
    '- 允许：' + tick('test/**'), '- 禁止：' + tick('forbidden.mjs'));
  check(body, ['a.mjs', 'b.mjs', 'test/sub/x.json'], 'ok');
  check(body, ['forbidden.mjs'], 'violation');
  check(allow('a.mjs') + '\n说明 ' + tick('b.mjs'), ['b.mjs'], 'violation');
});

test("Given 允许项为 `scripts/A.mjs`，When `['scripts/a.mjs']`，Then `'violation'`；Given 允许项为 `scripts/x.mjs`，When `['scripts\\\\x.mjs']`，Then `'violation'`；不得 realpath、大小写折叠或把反斜杠转为 `/`。", () => {
  check(allow('scripts/A.mjs'), ['scripts/a.mjs'], 'violation');
  check(allow('scripts/x.mjs'), ['scripts\\x.mjs'], 'violation');
  check(allow('scripts/a+b.mjs'), ['scripts/a+b.mjs'], 'ok');
  check(allow('scripts/a+b.mjs'), ['scripts/ab.mjs'], 'violation');
});

test("Given 已提交的固定 fixture、冻结的 `changedFiles` 数组和原始正文，When 重复调用并运行 `node --test`，Then 同输入结果不变、数组内容保持原样、没有网络/文件读写，全部测试退出码 0；When 检查 PR Files changed 和 diff，Then 仅白名单路径、改动总行数≤300、无依赖变更；测试未运行前标「未验证」。", () => {
  const body = original(6), files = Object.freeze(['scripts/collect.mjs', 'test/fixtures/a.json']);
  const before = structuredClone(files);
  for (let i = 0; i < 3; i++) {
    check(body, files, 'ok');
    assert.deepEqual(files, before);
    assert.equal(body, original(6));
  }
  assert.deepEqual(Object.keys(scope), ['classifyScope']);
  assert.equal(classifyScope(body, files) instanceof Promise, false);
  const program = [
    "import { readFileSync } from 'node:fs'; import vm from 'node:vm';",
    "import assert from 'node:assert/strict';",
    "const module = new vm.SourceTextModule(readFileSync('scripts/scope.mjs', 'utf8'),",
    "{ context: vm.createContext({}) });",
    "await module.link(() => { throw Error('IO/import forbidden'); });",
    "await module.evaluate({ timeout: 1000 });",
    "const classify = module.namespace.classifyScope;",
    'const body = ' + JSON.stringify(body) + ';',
    "const files = Object.freeze(['scripts/collect.mjs']);",
    "assert.equal(classify(body, files), 'ok');",
    "assert.equal(classify(body, files), 'ok');",
    "assert.equal(classify(body, ['outside.mjs']), 'violation');",
    "assert.equal(classify('', files), null);",
  ].join('\n');
  const child = spawnSync(process.execPath,
    ['--experimental-vm-modules', '--input-type=module', '--eval', program],
    { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 10000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
});

