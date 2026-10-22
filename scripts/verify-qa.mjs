import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

async function defaultGhFn(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { shell: false, timeout: 5000, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = value => typeof value === 'string' && value.length === 40 && /^[a-f\d]{40}$/i.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const requireValid = condition => { if (!condition) throw new Error('Invalid input'); };
const unknownQa = '无有效 QA 结论／需人工判断';
const blockLabels = ['QA SHA 不匹配', '总行数 >300', 'PR 非 OPEN'];
function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value.replace('Z', '.000Z');
}
function candidate(comment) {
  if (!record(comment) || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)
    || typeof comment.body !== 'string' || !utc(comment.created_at)
    || !Number.isSafeInteger(comment.id) || comment.id <= 0) return null;
  const conclusion = /QA 结论：(PASS|FAIL)(?![\w])/.exec(comment.body);
  const tested = /被测 commit：([a-fA-F\d]{40})(?![\w])/.exec(comment.body);
  return conclusion && tested ? { qa: conclusion[1], tested: tested[1],
    createdAt: comment.created_at, id: comment.id } : null;
}
const redNames = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock',
  'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.json', 'deno.jsonc', 'deno.lock',
  '.mocharc.json', '.mocharc.js', '.mocharc.cjs', '.mocharc.yml', '.mocharc.yaml', '.nycrc', '.nycrc.json']);
function redCard(path) {
  const name = path.split('/').at(-1);
  return path.startsWith('.github/') || path.startsWith('vendor/')
    || ['AGENTS.md', 'ARCHITECTURE.md', 'projects.json'].includes(path) || redNames.has(name)
    || /^(?:vitest|jest|playwright|karma|ava|nyc)\.config\.(?:[cm]?[jt]s|json)$/.test(name);
}

/** Read PR facts only; injected ghFn keeps callers and tests independent of CLI IO. */
export async function verifyPr({ owner, repo, prNumber, ghFn = defaultGhFn } = {}) {
  let pull, selected, files, blocks, exitCode;
  try {
    requireValid(typeof owner === 'string' && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(owner)
      && typeof repo === 'string' && /^[a-z\d_.-]+$/i.test(repo) && !['.', '..'].includes(repo)
      && !/\s/.test(owner + repo)
      && Number.isSafeInteger(prNumber) && prNumber > 0 && typeof ghFn === 'function');
    const base = `repos/${owner}/${repo}`;
    async function get(endpoint, paginated = false) {
      const raw = await ghFn(['api', '--method', 'GET', `${base}/${endpoint}`,
        ...(paginated ? ['--paginate', '--slurp'] : [])]);
      requireValid(typeof raw === 'string');
      const value = JSON.parse(raw);
      if (!paginated) return value;
      requireValid(Array.isArray(value) && value.every(Array.isArray));
      return value.flat();
    }
    const data = await get(`pulls/${prNumber}`);
    requireValid(record(data) && ['open', 'closed'].includes(data.state) && sha(data.head?.sha)
      && count(data.additions) && count(data.deletions));
    pull = data;
    const comments = await get(`issues/${prNumber}/comments?per_page=100`, true);
    selected = comments.map(candidate).filter(Boolean).sort((left, right) =>
      left.createdAt === right.createdAt ? right.id - left.id : left.createdAt > right.createdAt ? -1 : 1)[0];
    const changed = await get(`pulls/${prNumber}/files?per_page=100`, true);
    requireValid(changed.every(file => record(file) && typeof file.filename === 'string'));
    files = changed.map(file => file.filename);
    blocks = [Boolean(selected && selected.tested.toLowerCase() !== pull.head.sha.toLowerCase()),
      pull.additions + pull.deletions > 300, pull.state !== 'open'];
    exitCode = blocks.some(Boolean) ? 1 : 0;
  } catch {
    exitCode = 2;
  }
  const reds = files?.filter(redCard);
  const report = [`PR #${prNumber ?? '未知'}`, `PR state：${pull?.state.toUpperCase() ?? '未知'}`,
    `head SHA：${pull?.head.sha ?? '未知'}`, `QA 结论：${selected?.qa ?? unknownQa}`,
    `QA 被测 commit：${selected?.tested ?? unknownQa}`,
    ...(selected?.qa === 'FAIL' ? ['QA=FAIL（需人工判断）'] : []),
    `新增行数：${pull?.additions ?? '未知'}`, `删除行数：${pull?.deletions ?? '未知'}`,
    `总行数：${pull ? pull.additions + pull.deletions : '未知'}`, '完整文件列表：',
    ...(files ? files.map(path => `- ${path}`) : ['未知（未完成读取）']),
    `红牌提示：${reds ? reds.length ? '\n' + reds.map(path =>
      `- ${path}：需人工确认已获架构批准`).join('\n') : '无' : '未知（未完成读取）'}`,
    ...blockLabels.map((label, i) => `${label}：${blocks ? blocks[i] ? '是' : '否' : '未知（工具或环境错误）'}`),
    ...(exitCode === 2 ? ['工具或环境错误：无法读取或校验输入，请检查参数、gh 环境及返回数据。'] : []),
    ...(exitCode === 0 ? ['仅机械检查未阻断，不等于 QA PASS/允许合并'] : []),
    `最终退出码：${exitCode}`].join('\n') + '\n';
  return { exitCode, report };
}

export function isMainModule(argv1, moduleUrl, realpathFn = realpathSync) {
  try { return Boolean(argv1) && realpathFn(argv1) === realpathFn(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

if (isMainModule(process.argv[1], import.meta.url)) {
  const argument = process.argv[2];
  const prNumber = process.argv.length === 3 && /^[1-9]\d*$/.test(argument) ? Number(argument) : NaN;
  const { exitCode, report } = await verifyPr({ owner: 'zwmhua2-lab2', repo: 'HAC-Workbench', prNumber });
  (exitCode === 2 ? process.stderr : process.stdout).write(report);
  process.exitCode = exitCode;
}
