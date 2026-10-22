/** Parse explicit risk annotations only; missing or conflicting values stay null. */
export function parseRisk(issueBody) {
  if (typeof issueBody !== 'string') return null;
  const pattern = /^[ \t]*(?:-[ \t]*)?风险：[ \t]*(?:\*\*(高|低|unknown)\*\*|(高|低|unknown))(?=[ \t]*(?:[；;]|\r?$))/gm;
  const values = new Set(Array.from(issueBody.matchAll(pattern), match => match[1] ?? match[2]));
  return values.size === 1 ? values.values().next().value : null;
}

function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return false;
  const millis = Date.parse(value);
  return Number.isFinite(millis) && new Date(millis).toISOString() === value.replace('Z', '.000Z');
}

/** Select a complete, trusted QA comment without mutating inputs or checking PR head. */
export function parseQa(comments) {
  if (!Array.isArray(comments)) return null;
  let selected = null;
  for (const comment of comments) {
    if (comment === null || typeof comment !== 'object' || Array.isArray(comment)
      || typeof comment.body !== 'string' || !utc(comment.created_at)
      || !Number.isSafeInteger(comment.id) || comment.id <= 0
      || !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(comment.author_association)) continue;
    const conclusion = /QA 结论：(PASS|FAIL)(?![\w])/.exec(comment.body);
    const tested = /被测 commit：([a-fA-F\d]{40})(?![\w])/.exec(comment.body);
    if (!conclusion || !tested) continue;
    if (!selected || comment.created_at > selected.created_at
      || (comment.created_at === selected.created_at && comment.id > selected.id))
      selected = { created_at: comment.created_at, id: comment.id,
        qa: conclusion[1], tested_commit: tested[1] };
  }
  return selected ? { qa: selected.qa, tested_commit: selected.tested_commit } : null;
}
