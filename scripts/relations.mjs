const clause = '(?:closes|fixes|resolves):?[ \\t]+#[1-9][0-9]*';
const instruction = new RegExp(`^\\s*(?:-\\s+)?${clause}(?:[ \\t]*,[ \\t]*${clause})*[ \\t]*$`, 'i');

function validate(items) {
  if (!Array.isArray(items)) throw new TypeError('Expected an array');
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || !Number.isSafeInteger(item.number) || item.number <= 0) {
      throw new TypeError('Expected objects with positive safe integer numbers');
    }
  }
}

function references(body) {
  const result = new Set();
  if (typeof body !== 'string') return result;
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const character = marker[1][0];
      if (fence === null) fence = character;
      else if (fence === character) fence = null;
      continue;
    }
    if (fence !== null || /^\s*>/.test(line) || !instruction.test(line)) continue;
    for (const match of line.matchAll(/#([1-9][0-9]*)/g)) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number)) result.add(number);
    }
  }
  return result;
}

/** Build project-local closing relations without IO or changes to the input. */
export function buildRelations(issues, prs) {
  validate(issues);
  validate(prs);
  const issueNumbers = new Set(issues.map(issue => issue.number));
  const byIssue = new Map();
  const uniquePrs = new Set();
  const matchedPrs = new Set();
  for (const pr of prs) {
    uniquePrs.add(pr.number);
    for (const number of references(pr.body)) {
      if (!issueNumbers.has(number)) continue;
      if (!byIssue.has(number)) byIssue.set(number, new Set());
      byIssue.get(number).add(pr.number);
      matchedPrs.add(pr.number);
    }
  }
  const ascending = (a, b) => a - b;
  const relations = [...byIssue.keys()].sort(ascending).map(issue => ({
    issue, prs: [...byIssue.get(issue)].sort(ascending),
  }));
  return { relations, unmatchedPrCount: uniquePrs.size - matchedPrs.size };
}
