// An in-memory fake of the GitHub REST endpoints review-policy uses.

export const API = 'https://api.github.test';

export function fakeGitHub(state) {
  const calls = [];
  const writes = [];

  function page(list, url) {
    const per = Number(url.searchParams.get('per_page') ?? 30);
    const p = Number(url.searchParams.get('page') ?? 1);
    const items = list.slice((p - 1) * per, p * per);
    const headers = {};
    if (p * per < list.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(p + 1));
      headers.link = `<${next}>; rel="next", <${url}>; rel="last"`;
    }
    return [200, items, headers];
  }

  const repo = `/repos/${state.repo}`;
  const routes = [
    ['GET', /^\/pulls\/(\d+)$/, (m) => (state.prs[m[1]] ? [200, state.prs[m[1]].pull] : [404, { message: 'Not Found' }])],
    ['GET', /^\/pulls$/, (m, url) => page(Object.values(state.prs).map((p) => p.pull), url)],
    ['GET', /^\/pulls\/(\d+)\/files$/, (m, url) => page(state.prs[m[1]].files, url)],
    ['GET', /^\/pulls\/(\d+)\/reviews$/, (m, url) => page(state.prs[m[1]].reviews, url)],
    ['GET', /^\/issues\/(\d+)\/timeline$/, (m, url) => page(state.prs[m[1]].timeline, url)],
    ['GET', /^\/contents\/\.github\/review-policy\.yml$/, (m, url) => {
      const text = state.config?.[url.searchParams.get('ref')];
      if (text === undefined) return [404, { message: 'Not Found' }];
      return [200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') }];
    }],
    ['GET', /^\/collaborators\/([^/]+)\/permission$/, (m) => {
      const p = state.permissions?.[decodeURIComponent(m[1]).toLowerCase()];
      return p ? [200, { permission: p === 'maintain' ? 'write' : p, role_name: p }] : [404, { message: 'Not Found' }];
    }],
    ['GET', /^\/commits\/([0-9a-f]+)\/check-runs$/, (m) => [200, { check_runs: (state.checkRuns ?? []).filter((c) => c.head_sha === m[1]) }]],
    ['POST', /^\/check-runs$/, (m, url, body) => {
      const run = { id: 1000 + (state.checkRuns ?? []).length, app: { slug: 'github-actions' }, ...body };
      (state.checkRuns ??= []).push(run);
      return [201, run];
    }],
    ['PATCH', /^\/check-runs\/(\d+)$/, (m, url, body) => {
      const run = state.checkRuns.find((c) => c.id === Number(m[1]));
      Object.assign(run, body);
      return [200, run];
    }],
  ];

  async function fetch(href, init) {
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (init.headers.authorization !== `Bearer ${state.token ?? 't0ken'}`) return respond(401, { message: 'Bad credentials' });
    if (!url.pathname.startsWith(repo + '/')) return respond(404, { message: 'Not Found' });
    const path = url.pathname.slice(repo.length);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    for (const [m, re, fn] of routes) {
      const match = m === method && re.exec(path);
      if (match) {
        if (method !== 'GET') writes.push({ method, path, body });
        const [status, data, headers] = fn(match, url, body);
        return respond(status, data, headers);
      }
    }
    return respond(404, { message: `no route ${method} ${path}` });
  }

  function respond(status, data, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  return { fetch, calls, writes, state };
}
