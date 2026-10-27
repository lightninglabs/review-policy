// A minimal GitHub REST client built on fetch, with pagination.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function nextLink(header) {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part);
    if (m) return m[1];
  }
  return null;
}

export function createClient({ token, apiUrl = 'https://api.github.com', fetch = globalThis.fetch, maxPages = 100 }) {
  if (!token) throw new Error('a GitHub token is required');
  const base = apiUrl.replace(/\/+$/, '');

  async function raw(method, pathOrUrl, { query, body } = {}) {
    const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : base + pathOrUrl);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const res = await fetch(url.toString(), {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
        'user-agent': 'review-policy',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const msg = data && typeof data === 'object' && data.message ? data.message : text;
      throw new GitHubError(`${method} ${url.pathname}: ${res.status} ${msg}`, res.status);
    }
    return { data, link: res.headers.get('link') };
  }

  return {
    async request(method, path, opts) {
      return (await raw(method, path, opts)).data;
    },

    // paginate follows Link: rel="next" and concatenates the pages. For
    // endpoints that wrap the list in an object, pass the key.
    async paginate(path, { query = {}, key } = {}) {
      const out = [];
      let next = path;
      let opts = { query: { per_page: 100, ...query } };
      for (let page = 0; next; page++) {
        if (page >= maxPages) throw new GitHubError(`${path}: more than ${maxPages} pages`);
        const { data, link } = await raw('GET', next, opts);
        const items = key ? data?.[key] : data;
        if (!Array.isArray(items)) throw new GitHubError(`${path}: expected a list`);
        out.push(...items);
        next = nextLink(link);
        // Never send the token anywhere but the API.
        if (next && !next.startsWith(base + '/')) throw new GitHubError(`${path}: unexpected next link ${next}`);
        // The next link already carries the query string.
        opts = {};
      }
      return out;
    },
  };
}
