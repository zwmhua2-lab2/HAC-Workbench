const FOURTEEN_DAYS = 14 * 24 * 60 * 60 * 1000;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha = (value) => typeof value === 'string' && /^[a-f\d]+$/i.test(value);

function utcMillis(value) {
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value);
  if (!parts) return NaN;
  const normalized = `${parts[1]}.${(parts[2] ?? '').padEnd(3, '0').slice(0, 3)}Z`;
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) && new Date(millis).toISOString() === normalized ? millis : NaN;
}

function validPr(pr) {
  return record(pr) && ['open', 'closed'].includes(pr.state) && typeof pr.merged === 'boolean'
    && sha(pr.head_sha) && ['PASS', 'FAIL', null].includes(pr.qa)
    && (pr.tested_commit === null || typeof pr.tested_commit === 'string')
    && ['ok', 'violation'].includes(pr.scope);
}

const matchesHead = (pr) => typeof pr.tested_commit === 'string'
  && pr.tested_commit.length > 0 && pr.head_sha.startsWith(pr.tested_commit);

/** Derive the first matching workflow state without IO, mutation, or an implicit clock. */
export function deriveStatus(issue, prs, nowIso) {
  try {
    if (!record(issue) || !['open', 'closed'].includes(issue.state)
      || !['高', '低', 'unknown'].includes(issue.risk)) return '未知';
    const created = utcMillis(issue.created_at);
    const now = utcMillis(nowIso);
    if (!Number.isFinite(created) || !Number.isFinite(now)) return '未知';
    if (issue.state === 'closed') return '已完成'; // ① takes priority over PR input.
    if (!Array.isArray(prs) || !Array.from(prs).every(validPr)) return '未知';
    if (prs.some((pr) => (pr.state === 'closed' && !pr.merged)
      || pr.qa === 'FAIL' || pr.scope === 'violation')) return '异常'; // ②
    const overdue = now - created > FOURTEEN_DAYS;
    if (prs.length === 0 && overdue) return '异常'; // ③
    if (issue.risk === 'unknown') return '未知'; // ④
    const open = prs.filter((pr) => pr.state === 'open');
    if (issue.risk === '高' && open.some((pr) => pr.qa === null || !matchesHead(pr))) return '待质检'; // ⑤
    if (open.some((pr) => issue.risk === '低' || (pr.qa === 'PASS' && matchesHead(pr)))) return '待合并'; // ⑥
    if (prs.length === 0 && !overdue) return '待开工'; // ⑦
    return '未知'; // ⑧
  } catch {
    return '未知';
  }
}
