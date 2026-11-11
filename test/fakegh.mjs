// An in-memory fake of the GitHub REST endpoints review-policy uses.

import { verify } from 'node:crypto';

export const API = 'https://api.github.test';

// checkJwt verifies an App JWT the way GitHub does: RS256, signed by the
// App's key, issued by the App, and valid for at most ten minutes.
export function checkJwt(jwt, app, now = Date.now()) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) return 'not a JWT';
  const [h, p, sig] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  if (header.alg !== 'RS256' || header.typ !== 'JWT') return 'bad header';
  if (!verify('sha256', Buffer.from(`${h}.${p}`), app.publicKey, Buffer.from(sig, 'base64url'))) return 'bad signature';
  if (payload.iss !== String(app.id)) return 'wrong issuer';
  const t = Math.floor(now / 1000);
  if (!(payload.iat <= t && payload.exp > t && payload.exp - payload.iat <= 600)) return 'bad times';
  return null;
}

export function fakeGitHub(state) {
  const calls = [];
  const writes = [];
  // Installation tokens minted by the fake App, and the revoked ones.
  const minted = new Set();
  const revoked = new Set();

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
  // Routes outside the repository, for App authentication.
  const appRoutes = [
    ['GET', /^\/app$/, () => [200, { id: state.app.id, slug: state.app.slug }]],
    ['GET', new RegExp(`^${repo}/installation$`), () => (state.app.installed === false ? [404, { message: 'Not Found' }] : [200, { id: state.app.installationId }])],
    ['POST', /^\/app\/installations\/(\d+)\/access_tokens$/, (m, url, body) => {
      if (Number(m[1]) !== state.app.installationId) return [404, { message: 'Not Found' }];
      const token = `ghs_${minted.size + 1}`;
      minted.add(token);
      state.tokenRequests = [...(state.tokenRequests ?? []), body];
      return [201, { token, expires_at: '2099-01-01T00:00:00Z' }];
    }],
  ];
  const routes = [
    ['GET', /^\/pulls\/(\d+)$/, (m) => (state.prs[m[1]] ? [200, state.prs[m[1]].pull] : [404, { message: 'Not Found' }])],
    ['GET', /^\/pulls$/, (m, url) => {
      const want = url.searchParams.get('state');
      let all = Object.values(state.prs).map((p) => p.pull);
      if (want && want !== 'all') all = all.filter((p) => (p.state ?? 'open') === want);
      return page(all, url);
    }],
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
      if (!p) return [404, { message: 'Not Found' }];
      // An object gives the raw API response, for custom repository
      // roles whose role_name is not a legacy permission.
      if (typeof p === 'object') return [200, p];
      return [200, { permission: p === 'maintain' ? 'write' : p, role_name: p }];
    }],
    ['GET', /^\/compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/, (m) => {
      const c = state.compare?.[m[1]];
      return c ? [200, { status: c.status ?? 'ahead', files: c.files.map((filename) => ({ filename })) }] : [404, { message: 'Not Found' }];
    }],
    ['GET', /^\/commits\/([0-9a-f]+)\/check-runs$/, (m) => [200, { check_runs: (state.checkRuns ?? []).filter((c) => c.head_sha === m[1]) }]],
    ['POST', /^\/check-runs$/, (m, url, body, slug) => {
      const run = { id: 1000 + (state.checkRuns ?? []).length, app: { slug }, ...body };
      (state.checkRuns ??= []).push(run);
      return [201, run];
    }],
    ['PATCH', /^\/check-runs\/(\d+)$/, (m, url, body, slug) => {
      const run = state.checkRuns.find((c) => c.id === Number(m[1]));
      if (run.app.slug !== slug) return [403, { message: 'Resource not accessible by integration' }];
      Object.assign(run, body);
      return [200, run];
    }],
  ];

  async function fetch(href, init) {
    const url = new URL(href);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const bearer = String(init.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = init?.body ? JSON.parse(init.body) : undefined;
    if (state.app) {
      for (const [m, re, fn] of appRoutes) {
        const match = m === method && re.exec(url.pathname);
        if (!match) continue;
        const bad = checkJwt(bearer, state.app);
        if (bad) return respond(401, { message: `A JSON web token could not be decoded: ${bad}` });
        const [status, data] = fn(match, url, body);
        return respond(status, data);
      }
    }
    if (method === 'DELETE' && url.pathname === '/installation/token') {
      if (!minted.has(bearer)) return respond(401, { message: 'Bad credentials' });
      revoked.add(bearer);
      return new Response(null, { status: 204 });
    }
    let slug;
    if (minted.has(bearer) && !revoked.has(bearer)) slug = state.app.slug;
    else if (bearer === (state.token ?? 't0ken')) slug = 'github-actions';
    else return respond(401, { message: 'Bad credentials' });
    if (!url.pathname.startsWith(repo + '/')) return respond(404, { message: 'Not Found' });
    const path = url.pathname.slice(repo.length);
    // Injected failures: state.errors maps "METHOD path" to a status.
    const fail = state.errors?.[`${method} ${path}`];
    if (fail) return respond(fail, { message: 'injected error' });
    for (const [m, re, fn] of routes) {
      const match = m === method && re.exec(path);
      if (match) {
        if (method !== 'GET') writes.push({ method, path, body, slug });
        const [status, data, headers] = fn(match, url, body, slug);
        return respond(status, data, headers);
      }
    }
    return respond(404, { message: `no route ${method} ${path}` });
  }

  function respond(status, data, headers = {}) {
    return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  return { fetch, calls, writes, state, minted, revoked };
}
