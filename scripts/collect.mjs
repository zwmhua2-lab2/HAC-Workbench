const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function utc(value) {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value);
  if (!parts) return false;
  const normalized = parts[1] + '.' + (parts[2] ?? '').padEnd(3, '0').slice(0, 3) + 'Z';
  const millis = Date.parse(normalized);
  return Number.isFinite(millis) && new Date(millis).toISOString() === normalized;
}
function requireValid(condition, message) {
  if (!condition) throw new Error(message);
}
function fact(row, pull) {
  requireValid(record(row) && Number.isSafeInteger(row.number) && row.number > 0
    && typeof row.title === 'string' && (row.body === null || typeof row.body === 'string')
    && ['open', 'closed'].includes(row.state) && utc(row.created_at) && utc(row.updated_at)
    && (row.closed_at === null || utc(row.closed_at)) && typeof row.html_url === 'string', 'Invalid fact');
  const { number, title, body, state, created_at, updated_at, closed_at, html_url } = row;
  const out = { number, title, body, state, created_at, updated_at, closed_at, html_url };
  if (pull) {
    requireValid((row.merged_at === null || utc(row.merged_at)) && record(row.head)
      && typeof row.head.sha === 'string' && /^[a-f\d]{40}$/i.test(row.head.sha), 'Invalid pull');
    out.merged_at = row.merged_at;
    out.head = { sha: row.head.sha };
  }
  return out;
}

/** Collect anonymous REST facts as one complete value; all IO is an injected GET. */
export async function collectFacts(manifest, { fetchFn = globalThis.fetch, nowIso,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  try {
    requireValid(record(manifest) && Array.isArray(manifest.projects)
      && manifest.projects.length >= 1 && manifest.projects.length <= 2, 'Invalid manifest');
    const ids = new Set();
    for (const project of manifest.projects) {
      requireValid(record(project) && typeof project.id === 'string' && project.id.trim().length > 0
        && !ids.has(project.id) && typeof project.repo === 'string'
        && /^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(project.repo)
        && !['.', '..'].includes(project.repo.split('/')[1]), 'Invalid project');
      ids.add(project.id);
    }
    requireValid(utc(nowIso) && [fetchFn, setTimer, clearTimer].every(fn => typeof fn === 'function'),
      'Invalid options');
    async function get(url) {
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimer(() => {
          reject(new Error('Request timeout'));
          controller.abort();
        }, 5000);
      });
      try {
        return await Promise.race([timeout, (async () => {
          const response = await fetchFn(url, { method: 'GET', signal: controller.signal,
            credentials: 'omit', redirect: 'error' });
          requireValid(record(response) && Number.isInteger(response.status)
            && response.status >= 200 && response.status < 300, 'HTTP failure');
          const rows = await response.json();
          requireValid(Array.isArray(rows), 'Expected array');
          return rows;
        })()]);
      } finally {
        clearTimer(timer);
      }
    }
    async function list(repo, endpoint) {
      const result = [];
      for (let page = 1; ; page++) {
        const rows = await get('https://api.github.com/repos/' + repo + '/' + endpoint
          + '?state=all&per_page=100&page=' + page);
        requireValid(rows.length <= 100, 'Oversized page');
        for (const row of rows) {
          requireValid(record(row), 'Invalid row');
          if (endpoint === 'issues' && Object.hasOwn(row, 'pull_request')) continue;
          result.push(fact(row, endpoint === 'pulls'));
        }
        if (rows.length < 100) return result;
      }
    }
    const projects = [];
    for (const { id, repo } of manifest.projects) {
      const issues = await list(repo, 'issues');
      const prs = await list(repo, 'pulls');
      projects.push({ id, issues, prs });
    }
    return { as_of: nowIso, projects };
  } catch (cause) {
    throw Object.assign(new Error('COLLECT_ERROR', { cause }), { code: 'COLLECT_ERROR', exitCode: 1 });
  }
}
