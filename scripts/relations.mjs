const FENCE = /^[ \t]*(`{3,}|~{3,})/;
const QUOTE = /^[ \t]*>/;
const CLAUSE = '(?:closes|fixes|resolves):?[ \\t]+#[1-9][0-9]*';
const DIRECTIVE = new RegExp(`^[ \\t]*(?:-[ \\t]+)?(${CLAUSE}(?:[ \\t]*,[ \\t]*${CLAUSE})*)[ \\t]*$`, 'i');
const NUMBERS = /#([1-9][0-9]*)/g;

function requireList(value, name) {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
}

function requireEntry(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
    || !Number.isSafeInteger(entry.number) || entry.number <= 0) throw new TypeError('invalid entry');
}

/** Keep only lines outside fences and blockquotes. */
function scannableLines(body) {
  const lines = [];
  let fence = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = FENCE.exec(line);
    if (marker) {
      const char = marker[1][0];
      if (fence === null) fence = char;
      else if (fence === char) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (QUOTE.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function referencedNumbers(body) {
  if (typeof body !== 'string') return [];
  const numbers = [];
  for (const line of scannableLines(body)) {
    const directive = DIRECTIVE.exec(line);
    if (!directive) continue;
    for (const match of directive[1].matchAll(NUMBERS)) {
      const number = Number(match[1]);
      if (number <= Number.MAX_SAFE_INTEGER) numbers.push(number);
    }
  }
  return numbers;
}

/** Derive Issue to PR relations from explicit closing directives only. */
export function buildRelations(issues, prs) {
  requireList(issues, 'issues');
  requireList(prs, 'prs');
  issues.forEach(requireEntry);
  prs.forEach(requireEntry);

  const known = new Set(issues.map(entry => entry.number));
  const byPr = new Map();
  for (const pull of prs) {
    for (const number of referencedNumbers(pull.body)) {
      if (!known.has(number)) continue;
      if (!byPr.has(pull.number)) byPr.set(pull.number, new Set());
      byPr.get(pull.number).add(number);
    }
  }

  const byIssue = new Map();
  for (const [prNumber, numbers] of byPr) {
    for (const issueNumber of numbers) {
      if (!byIssue.has(issueNumber)) byIssue.set(issueNumber, new Set());
      byIssue.get(issueNumber).add(prNumber);
    }
  }

  const relations = [...byIssue.keys()].sort((left, right) => left - right).map(issueNumber => ({
    issue: issueNumber,
    prs: [...byIssue.get(issueNumber)].sort((left, right) => left - right),
  }));
  const uniquePrs = new Set(prs.map(entry => entry.number));
  return { relations, unmatchedPrCount: uniquePrs.size - byPr.size };
}
