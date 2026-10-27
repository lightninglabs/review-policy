// Path globs for policy rules.
//
// Patterns are matched against the whole repository-relative path:
//   **   matches any number of path segments, including none
//   *    matches any run of characters within one segment
//   ?    matches one character within a segment
// Everything else is literal, and dot files get no special treatment.
// A pattern without a slash, like "go.mod", matches only at the root;
// write "**/go.mod" to match it anywhere.

const cache = new Map();

export function globToRegExp(pattern) {
  if (typeof pattern !== 'string' || pattern === '') {
    throw new Error('glob must be a non-empty string');
  }
  let re = '';
  const segs = pattern.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      // "a/**" matches everything under a; "**/b" and "a/**/b" match zero
      // or more directories in between.
      re += last ? '.*' : '(?:[^/]+/)*';
      continue;
    }
    if (seg.includes('**')) throw new Error(`"**" must be a whole path segment in "${pattern}"`);
    for (const ch of seg) {
      if (ch === '*') re += '[^/]*';
      else if (ch === '?') re += '[^/]';
      else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    if (!last) re += '/';
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(pattern, path) {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchAny(patterns, path) {
  return patterns.some((p) => matchGlob(p, path));
}
