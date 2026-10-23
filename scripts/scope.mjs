function relativePath(value) {
  return typeof value === 'string' && value.length > 0
    && !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.includes('\0')
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function matcher(pattern) {
  if (!relativePath(pattern) || /[?{}[\]()|]/.test(pattern)
    || pattern.startsWith('!') || pattern.includes('***')) return null;
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '*') {
      expression += pattern[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (pattern[i + 1] !== '*') {
      expression += '[^/]*';
    } else {
      // A whole **/ segment also matches zero directory levels.
      if ((i === 0 || pattern[i - 1] === '/') && pattern[i + 2] === '/') {
        expression += '(?:[^/]+/)*';
        i++;
      } else expression += '[\\s\\S]*';
      i++;
    }
  }
  // Unlike $, this end assertion cannot accept a trailing newline.
  return new RegExp('^(?:' + expression + ')(?![\\s\\S])');
}

/** Classify complete PR paths against an Issue allowlist, without IO or mutation. */
export function classifyScope(issueBody, changedFiles) {
  if (typeof issueBody !== 'string' || !Array.isArray(changedFiles)
    || changedFiles.length === 0) return null;
  for (const file of changedFiles) if (!relativePath(file)) return null;
  let fence = null, active = false, sections = 0;
  const patterns = [];
  for (const line of issueBody.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (fence === null) fence = marker[1][0];
      else if (fence === marker[1][0]) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (line === '## 允许修改') {
      sections++;
      active = true;
      continue;
    }
    if (line.startsWith('## ')) active = false;
    if (!active || !line.startsWith('- 允许：')) continue;
    const paths = [...line.matchAll(/`([^`]*)`/g)];
    if (paths.length === 0 || (line.match(/`/g)?.length ?? 0) !== paths.length * 2)
      return null;
    for (const path of paths) {
      const compiled = matcher(path[1]);
      if (compiled === null) return null;
      patterns.push(compiled);
    }
  }
  if (sections !== 1 || patterns.length === 0) return null;
  return changedFiles.every(file => patterns.some(pattern => pattern.test(file)))
    ? 'ok' : 'violation';
}
