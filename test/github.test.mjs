import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createClient } from '../src/github.mjs';
import { run, gatherInputs, parseMergeGroupRef, SPOOF_WARNING } from '../src/main.mjs';
import { appJwt, installationToken, APP_PERMISSIONS } from '../src/app.mjs';
import { fakeGitHub, checkJwt, API } from './fakegh.mjs';
import { README_CONFIG, HEAD, OLD, BOT, APP } from './fixtures.mjs';

const REPO = 'lightninglabs/lnd-test';

function prState(over = {}) {
  const files = over.files ?? [{ filename: 'docs/a.md' }];
  return {
    pull: {
      number: 7,
      user: { login: 'author' },
      head: { sha: HEAD },
      base: { ref: 'master' },
      labels: (over.labels ?? ['severity-low']).map((name) => ({ name })),
      changed_files: over.changedFiles ?? files.length,
    },
    files,
    reviews: over.reviews ?? [],
    timeline: over.timeline ?? [
      { event: 'committed', sha: HEAD },
      { event: 'labeled', label: { name: 'severity-low' }, actor: { login: APP } },
    ],
  };
}

function review(id, login, state = 'APPROVED', commit = HEAD) {
  return { id, user: { login }, state, commit_id: commit, submitted_at: `2026-10-01T00:${String(Math.floor(id / 60) % 60).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}Z` };
}

function env(eventName, event, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rp-'));
  const path = join(dir, 'event.json');
  writeFileSync(path, JSON.stringify(event));
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: API,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: path,
    INPUT_TOKEN: 't0ken',
    INPUT_APP_LOGIN: APP,
    GITHUB_STEP_SUMMARY: join(dir, 'summary.md'),
    ...extra,
  };
}

function world(pr = prState(), over = {}) {
  return fakeGitHub({ repo: REPO, prs: { 7: pr }, config: { master: README_CONFIG }, permissions: { maint1: 'write', maint2: 'admin' }, ...over });
}

const quiet = () => {};

describe('client pagination', () => {
  test('follows Link headers across pages', async () => {
    const reviews = Array.from({ length: 250 }, (_, i) => review(i + 1, `u${i}`));
    const gh = world(prState({ reviews }));
    const client = createClient({ token: 't0ken', apiUrl: API, fetch: gh.fetch });
    const got = await client.paginate(`/repos/${REPO}/pulls/7/reviews`);
    assert.equal(got.length, 250);
    assert.equal(gh.calls.filter((c) => c.includes('/reviews')).length, 3);
  });

  test('refuses a next link that leaves the API host', async () => {
    const fetch = async () => new Response('[]', { status: 200, headers: { link: '<https://evil.test/x?page=2>; rel="next"' } });
    const client = createClient({ token: 't', apiUrl: API, fetch });
    await assert.rejects(client.paginate('/x'), /unexpected next link/);
  });

  test('caps the number of pages', async () => {
    const fetch = async (u) => new Response('[1]', { status: 200, headers: { link: `<${API}/x?page=2>; rel="next"` } });
    const client = createClient({ token: 't', apiUrl: API, fetch, maxPages: 3 });
    await assert.rejects(client.paginate('/x'), /more than 3 pages/);
  });

  test('reports HTTP errors with status', async () => {
    const gh = world();
    const client = createClient({ token: 'wrong', apiUrl: API, fetch: gh.fetch });
    await assert.rejects(client.request('GET', `/repos/${REPO}/pulls/7`), (e) => e.status === 401);
  });
});

describe('run', () => {
  test('LOW with a bot approval passes and creates one check run', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    const e = env('pull_request_target', { pull_request: { number: 7 } });
    const [r] = await run({ env: e, fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, true);
    assert.equal(gh.state.checkRuns.length, 1);
    const c = gh.state.checkRuns[0];
    assert.equal(c.name, 'review-policy');
    assert.equal(c.head_sha, HEAD);
    assert.equal(c.conclusion, 'success');
    assert.equal(c.output.title, 'LOW: bot approval (head abc1234)');
    assert.match(readFileSync(e.GITHUB_STEP_SUMMARY, 'utf8'), /PASS/);
  });

  test('a second run updates the same check run', async () => {
    const pr = prState({ labels: ['severity-critical'], timeline: [{ event: 'labeled', label: { name: 'severity-critical' }, actor: { login: 'maint1' } }], reviews: [review(1, 'maint1')] });
    const gh = world(pr);
    const e = env('pull_request_review', { pull_request: { number: 7 } });
    await run({ env: e, fetch: gh.fetch, log: quiet });
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
    assert.equal(gh.state.checkRuns[0].output.title, 'CRITICAL: 1 of 2 human approvals on abc1234');
    pr.reviews.push(review(2, 'maint2'));
    await run({ env: e, fetch: gh.fetch, log: quiet });
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].conclusion, 'success');
    assert.deepEqual(gh.writes.map((w) => w.method), ['POST', 'PATCH']);
  });

  test('does not update a check run from another app', async () => {
    const gh = world();
    gh.state.checkRuns = [{ id: 1, name: 'review-policy', head_sha: HEAD, app: { slug: 'evil-app' }, conclusion: 'success' }];
    await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(gh.state.checkRuns.length, 2);
    assert.equal(gh.state.checkRuns[0].conclusion, 'success');
    assert.equal(gh.state.checkRuns[1].conclusion, 'failure');
  });

  test('reads the config from the base branch, not the head', async () => {
    const gh = world(prState({ files: [{ filename: '.github/review-policy.yml' }], reviews: [review(1, BOT)] }), {
      config: { master: README_CONFIG, [HEAD]: 'version: 1\ntiers: {}' },
    });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.ok(gh.calls.some((c) => c.includes('/contents/.github/review-policy.yml?ref=master')));
    assert.equal(r.severity, 'critical');
    assert.equal(r.pass, false);
  });

  test('missing config fails closed', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { config: {} });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
    assert.match(gh.state.checkRuns[0].output.title, /not found on master/);
  });

  test('invalid config fails closed', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { config: { master: 'version: 1\nbots: [x' } });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /cannot parse YAML/);
  });

  test('paginates more than 100 files: a floored path on page 2 counts', async () => {
    const files = Array.from({ length: 150 }, (_, i) => ({ filename: `docs/f${i}.md` }));
    files[120] = { filename: 'lnwallet/wallet.go' };
    const gh = world(prState({ files, reviews: [review(1, BOT)] }));
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.details.paths, 150);
    assert.equal(r.severity, 'critical');
    assert.equal(r.pass, false);
  });

  test('paginates more than 100 reviews: the latest review on page 3 wins', async () => {
    const reviews = Array.from({ length: 230 }, (_, i) => review(i + 1, `drive-by${i}`, 'COMMENTED'));
    reviews[10] = review(11, 'maint1', 'APPROVED');
    reviews[120] = review(121, 'maint2', 'APPROVED');
    reviews[225] = review(226, 'maint1', 'CHANGES_REQUESTED');
    const pr = prState({ labels: ['severity-medium'], timeline: [{ event: 'labeled', label: { name: 'severity-medium' }, actor: { login: APP } }], reviews });
    const gh = world(pr);
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.deepEqual(r.details.humanApprovals, ['maint2']);
    assert.equal(r.pass, true);
  });

  test('paginates the timeline: a later author re-label on page 2 wins', async () => {
    const timeline = [{ event: 'labeled', label: { name: 'severity-low' }, actor: { login: 'maint1' } }];
    for (let i = 0; i < 120; i++) timeline.push({ event: 'commented', actor: { login: 'x' } });
    timeline.push({ event: 'unlabeled', label: { name: 'severity-low' }, actor: { login: 'author' } });
    timeline.push({ event: 'labeled', label: { name: 'severity-low' }, actor: { login: 'author' } });
    const gh = world(prState({ timeline, reviews: [review(1, BOT)] }));
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.match(r.reason, /^needs severity/);
  });

  test('approvals from non-collaborators do not count', async () => {
    const pr = prState({ labels: ['severity-medium'], timeline: [{ event: 'labeled', label: { name: 'severity-medium' }, actor: { login: APP } }], reviews: [review(1, 'outsider')] });
    const gh = world(pr);
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.ok(gh.calls.some((c) => c.includes('/collaborators/outsider/permission')));
  });

  test('workflow_dispatch evaluates the given PR', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    const [r] = await run({ env: env('workflow_dispatch', { inputs: { pr: '7' } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.number, 7);
  });

  test('workflow_dispatch rejects a non-numeric pr', async () => {
    const gh = world();
    await assert.rejects(run({ env: env('workflow_dispatch', { inputs: { pr: '7; rm -rf' } }), fetch: gh.fetch, log: quiet }), /numeric/);
  });

  test('workflow_run finds a fork PR by head SHA', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    const [r] = await run({ env: env('workflow_run', { workflow_run: { head_sha: HEAD, pull_requests: [] } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.number, 7);
    assert.equal(gh.state.checkRuns[0].head_sha, HEAD);
  });

  test('workflow_run with a stale head SHA does nothing', async () => {
    const gh = world();
    const results = await run({ env: env('workflow_run', { workflow_run: { head_sha: OLD.replace(/[^0-9a-f]/g, '0'), pull_requests: [] } }), fetch: gh.fetch, log: quiet });
    assert.deepEqual(results, []);
    assert.equal(gh.writes.length, 0);
  });

  test('the head SHA comes from the API, not the event payload', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    await run({ env: env('pull_request_target', { pull_request: { number: 7, head: { sha: 'f'.repeat(40) } } }), fetch: gh.fetch, log: quiet });
    assert.equal(gh.state.checkRuns[0].head_sha, HEAD);
  });

  test('more changed files than the API lists fails closed', async () => {
    const gh = world(prState({ changedFiles: 3500, reviews: [review(1, BOT)] }));
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /cannot list every changed file/);
  });

  test('gatherInputs looks up permissions only for relevant actors', async () => {
    const gh = world(prState({ reviews: [review(1, BOT), review(2, 'author'), review(3, 'maint1'), review(4, 'maint2', 'COMMENTED')] }));
    const client = createClient({ token: 't0ken', apiUrl: API, fetch: gh.fetch });
    const input = await gatherInputs(client, REPO, 7, { appLogin: APP });
    assert.deepEqual(input.permissions, { maint1: 'write' });
  });
});

const { privateKey: KEY, publicKey: PUB } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const APP_STATE = { id: 4242, slug: 'review-policy', installationId: 99, publicKey: PUB };
const appEnv = (eventName, event, extra = {}) =>
  env(eventName, event, { INPUT_APP_ID: '4242', INPUT_PRIVATE_KEY: KEY, INPUT_APP_LOGIN: '', INPUT_TOKEN: '', ...extra });

describe('App authentication', () => {
  test('appJwt signs an RS256 JWT the API accepts', () => {
    const jwt = appJwt(4242, KEY);
    assert.equal(checkJwt(jwt, APP_STATE), null);
    const [h, p] = jwt.split('.').slice(0, 2).map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
    assert.deepEqual(h, { alg: 'RS256', typ: 'JWT' });
    assert.equal(p.iss, '4242');
    assert.equal(p.exp - p.iat, 600);
    assert.ok(p.iat <= Math.floor(Date.now() / 1000) - 59);
  });

  test('appJwt accepts a key with literal \\n escapes', () => {
    assert.equal(checkJwt(appJwt('4242', KEY.replace(/\n/g, '\\n')), APP_STATE), null);
  });

  test('a JWT from another key or App id is rejected', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.equal(checkJwt(appJwt(4242, other.privateKey), APP_STATE), 'bad signature');
    assert.equal(checkJwt(appJwt(4243, KEY), APP_STATE), 'wrong issuer');
  });

  test('appJwt rejects bad inputs without echoing the key', () => {
    assert.throws(() => appJwt('abc', KEY), /numeric/);
    assert.throws(() => appJwt('', KEY), /numeric/);
    assert.throws(() => appJwt(1, 'SECRET-NOT-A-KEY'), (e) => /not a PEM private key/.test(e.message) && !e.message.includes('SECRET'));
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.throws(() => appJwt(1, ec.privateKey), /RSA/);
  });

  test('installationToken mints a repo-scoped token with only the needed permissions', async () => {
    const gh = world(prState(), { app: { ...APP_STATE } });
    const t = await installationToken({ appId: '4242', privateKey: KEY, repo: REPO, apiUrl: API, fetch: gh.fetch });
    assert.deepEqual(t, { token: 'ghs_1', slug: 'review-policy', login: 'review-policy[bot]' });
    assert.deepEqual(gh.state.tokenRequests, [{ repositories: ['lnd-test'], permissions: APP_PERMISSIONS }]);
    assert.deepEqual(APP_PERMISSIONS, { checks: 'write', contents: 'read', pull_requests: 'read' });
  });

  test('installationToken fails when the App is not installed', async () => {
    const gh = world(prState(), { app: { ...APP_STATE, installed: false } });
    await assert.rejects(installationToken({ appId: '4242', privateKey: KEY, repo: REPO, apiUrl: API, fetch: gh.fetch }), (e) => e.status === 404);
  });

  test('run reports as the App, counts its labels, and revokes the token', async () => {
    const pr = prState({ reviews: [review(1, BOT)], timeline: [{ event: 'labeled', label: { name: 'severity-low' }, actor: { login: 'review-policy[bot]' } }] });
    const gh = world(pr, { app: { ...APP_STATE } });
    const logs = [];
    const e = appEnv('pull_request_target', { pull_request: { number: 7 } });
    const [r] = await run({ env: e, fetch: gh.fetch, log: (l) => logs.push(l) });
    assert.equal(r.pass, true, r.reason);
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].app.slug, 'review-policy');
    assert.ok(gh.writes.every((w) => w.slug === 'review-policy'));
    assert.ok(!gh.state.checkRuns[0].output.summary.includes('spoofed'));
    assert.ok(!readFileSync(e.GITHUB_STEP_SUMMARY, 'utf8').includes('spoofed'));
    assert.ok(logs.includes('::add-mask::ghs_1'));
    assert.deepEqual([...gh.revoked], ['ghs_1']);
  });

  test('the App updates its own check run, not one from GitHub Actions', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { app: { ...APP_STATE } });
    gh.state.checkRuns = [{ id: 1, name: 'review-policy', head_sha: HEAD, app: { slug: 'github-actions' }, conclusion: 'success' }];
    const e = appEnv('pull_request_target', { pull_request: { number: 7 } }, { INPUT_APP_LOGIN: APP });
    await run({ env: e, fetch: gh.fetch, log: quiet });
    await run({ env: e, fetch: gh.fetch, log: quiet });
    assert.deepEqual(gh.state.checkRuns.map((c) => c.app.slug), ['github-actions', 'review-policy']);
    assert.deepEqual(gh.writes.map((w) => w.method), ['POST', 'PATCH']);
  });

  test('app_login overrides the default App login', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { app: { ...APP_STATE } });
    const [r] = await run({ env: appEnv('pull_request_target', { pull_request: { number: 7 } }, { INPUT_APP_LOGIN: 'classifier-app[bot]' }), fetch: gh.fetch, log: quiet });
    assert.match(r.reason, /^needs severity/);
  });

  test('a wrong private key fails before anything is written', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const gh = world(prState(), { app: { ...APP_STATE } });
    await assert.rejects(run({ env: appEnv('pull_request_target', { pull_request: { number: 7 } }, { INPUT_PRIVATE_KEY: other.privateKey }), fetch: gh.fetch, log: quiet }), (e) => e.status === 401);
    assert.equal(gh.writes.length, 0);
  });

  test('app_id without private_key fails instead of falling back', async () => {
    const gh = world(prState(), { app: { ...APP_STATE } });
    await assert.rejects(run({ env: appEnv('pull_request_target', { pull_request: { number: 7 } }, { INPUT_PRIVATE_KEY: '', INPUT_TOKEN: 't0ken' }), fetch: gh.fetch, log: quiet }), /private_key is empty/);
    await assert.rejects(run({ env: appEnv('pull_request_target', { pull_request: { number: 7 } }, { INPUT_APP_ID: '', INPUT_TOKEN: 't0ken' }), fetch: gh.fetch, log: quiet }), /app_id is empty/);
    assert.equal(gh.writes.length, 0);
  });

  test('without the App, GITHUB_TOKEN reports with a loud spoofing warning', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    const logs = [];
    const e = env('pull_request_target', { pull_request: { number: 7 } });
    await run({ env: e, fetch: gh.fetch, log: (l) => logs.push(l) });
    assert.ok(gh.state.checkRuns[0].output.summary.startsWith(SPOOF_WARNING));
    assert.ok(readFileSync(e.GITHUB_STEP_SUMMARY, 'utf8').includes(SPOOF_WARNING));
    assert.ok(logs.some((l) => l.startsWith('::warning::') && /spoofed/.test(l)));
  });

  test('without the App, github-actions[bot] labels still do not count', async () => {
    const pr = prState({ reviews: [review(1, BOT)], timeline: [{ event: 'labeled', label: { name: 'severity-low' }, actor: { login: 'github-actions[bot]' } }] });
    const gh = world(pr);
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }, { INPUT_APP_LOGIN: '' }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /^needs severity.*github-actions\[bot\], which any workflow can act as/);
  });
});

const GROUP_SHA = 'e'.repeat(40);
const groupRef = (n = 7, base = 'master') => `refs/heads/gh-readonly-queue/${base}/pr-${n}-${'a'.repeat(40)}`;
const groupEvent = (over = {}) => ({ merge_group: { head_sha: GROUP_SHA, head_ref: groupRef(), base_sha: 'f'.repeat(40), base_ref: 'refs/heads/master', ...over } });

describe('merge_group', () => {
  test('parses queue refs', () => {
    assert.deepEqual(parseMergeGroupRef(groupRef(7)), { base: 'master', number: 7, sha: 'a'.repeat(40) });
    assert.deepEqual(parseMergeGroupRef(groupRef(10424, 'release/v0.19')), { base: 'release/v0.19', number: 10424, sha: 'a'.repeat(40) });
    assert.equal(parseMergeGroupRef(`refs/heads/gh-readonly-queue/main/pr-3-${'b'.repeat(64)}`).number, 3);
  });

  for (const bad of [
    undefined,
    '',
    'gh-readonly-queue/master/pr-7-' + 'a'.repeat(40),
    'refs/heads/master',
    'refs/heads/gh-readonly-queue/master/pr-7',
    'refs/heads/gh-readonly-queue/master/pr--7-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-0-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-07-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-x-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-7-' + 'a'.repeat(39),
    'refs/heads/gh-readonly-queue/master/pr-7-' + 'A'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-7-' + 'a'.repeat(40) + '/x',
    'refs/heads/gh-readonly-queue//pr-7-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/pr-7-' + 'a'.repeat(40),
    'refs/heads/gh-readonly-queue/master/pr-99999999999999999999-' + 'a'.repeat(40),
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => assert.equal(parseMergeGroupRef(bad), null));
  }

  test('evaluates the PR on its head and reports on the merge group head', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { app: { ...APP_STATE } });
    const e = appEnv('merge_group', groupEvent(), { INPUT_APP_LOGIN: APP });
    const [r] = await run({ env: e, fetch: gh.fetch, log: quiet });
    assert.equal(r.number, 7);
    assert.equal(r.pass, true, r.reason);
    assert.equal(r.details.headSha, HEAD);
    assert.equal(gh.state.checkRuns.length, 1);
    const c = gh.state.checkRuns[0];
    assert.equal(c.head_sha, GROUP_SHA);
    assert.equal(c.conclusion, 'success');
    assert.equal(c.app.slug, 'review-policy');
    assert.match(c.output.summary, /Merge group \| `e{40}`, evaluated as PR #7/);
    assert.ok(!gh.calls.some((cl) => cl.includes(`/commits/${HEAD}/check-runs`)));
  });

  test('a PR that no longer meets the policy fails the queue entry', async () => {
    const gh = world(prState({ reviews: [review(1, BOT, 'APPROVED', 'b'.repeat(40))] }));
    const [r] = await run({ env: env('merge_group', groupEvent()), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.equal(gh.state.checkRuns[0].head_sha, GROUP_SHA);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
  });

  for (const [name, over] of [
    ['an unparsable ref', { head_ref: 'refs/heads/some-branch' }],
    ['a missing ref', { head_ref: undefined }],
    ['a ref whose base does not match base_ref', { base_ref: 'refs/heads/main' }],
  ]) {
    test(`${name} fails closed on the group head`, async () => {
      const gh = world(prState({ reviews: [review(1, BOT)] }));
      await assert.rejects(run({ env: env('merge_group', groupEvent(over)), fetch: gh.fetch, log: quiet }), /merge group/);
      assert.equal(gh.state.checkRuns.length, 1);
      assert.equal(gh.state.checkRuns[0].head_sha, GROUP_SHA);
      assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
      assert.ok(!gh.calls.some((c) => c.includes('/pulls/7')));
    });
  }

  test('no head_sha: nothing to report on, and the run fails', async () => {
    const gh = world();
    await assert.rejects(run({ env: env('merge_group', groupEvent({ head_sha: undefined })), fetch: gh.fetch, log: quiet }), /no head_sha/);
    assert.equal(gh.writes.length, 0);
  });

  test('a PR that targets another branch than the queue fails', async () => {
    const gh = world();
    gh.state.prs[7].pull.base.ref = 'other';
    gh.state.config.other = README_CONFIG;
    const [r] = await run({ env: env('merge_group', groupEvent()), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /targets other, not the merge group's base master/);
  });
});

describe('carry: low_only through the compare API', () => {
  const APPROVED = 'b'.repeat(40);
  // routing/** floors LOW here instead of HIGH, so a MEDIUM PR keeps its
  // tier when the path is part of its own diff.
  const CARRY_CONFIG = README_CONFIG
    .replace('  high: ["htlcswitch/**", "routing/**", "peer/**"]', '  high: ["htlcswitch/**", "peer/**"]')
    .replace('floor:\n', 'floor:\n  low: ["routing/**"]\n');
  const medium = (reviews, over = {}) => prState({
    labels: ['severity-medium'],
    timeline: [{ event: 'labeled', label: { name: 'severity-medium' }, actor: { login: APP } }],
    reviews,
    ...over,
  });
  const carryWorld = (pr, compare) => world(pr, { compare, config: { master: CARRY_CONFIG } });

  test('carries an approval when only low-risk files changed since', async () => {
    const gh = carryWorld(medium([review(1, 'maint1', 'APPROVED', APPROVED)]), { [APPROVED]: { files: ['docs/a.md'] } });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.ok(gh.calls.some((c) => c === `GET /repos/${REPO}/compare/${APPROVED}...${HEAD}`));
    assert.equal(r.pass, true, r.reason);
    assert.match(gh.state.checkRuns[0].output.summary, /Carried from older commits \| maint1/);
  });

  test('carries an approval past base-branch churn', async () => {
    // routing/r.go and go.mod changed only because the base branch moved;
    // neither is part of the PR's own diff.
    const gh = carryWorld(medium([review(1, 'maint1', 'APPROVED', APPROVED)]), { [APPROVED]: { files: ['docs/a.md', 'routing/r.go', 'go.mod'] } });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, true, r.reason);
    assert.match(r.reason, /MEDIUM: 1 of 1 human approval/);
  });

  for (const [what, prOver, compare] of [
    ['a floored file', { files: [{ filename: 'docs/a.md' }, { filename: 'routing/r.go' }] }, { [APPROVED]: { files: ['docs/a.md', 'routing/r.go'] } }],
    ['a never-auto-approve file', { files: [{ filename: 'docs/a.md' }, { filename: 'scripts/x.sh' }] }, { [APPROVED]: { files: ['docs/a.md', 'scripts/x.sh'] } }],
    ['the policy file', { files: [{ filename: 'docs/a.md' }, { filename: '.github/review-policy.yml' }] }, { [APPROVED]: { files: ['docs/a.md', '.github/review-policy.yml'] } }],
    ['a force-push', {}, { [APPROVED]: { status: 'diverged', files: ['docs/a.md'] } }],
    ['300 or more files', {}, { [APPROVED]: { files: Array.from({ length: 300 }, (_, i) => `docs/${i}.md`) } }],
    ['an unknown commit', {}, {}],
  ]) {
    test(`does not carry past ${what}`, async () => {
      const gh = carryWorld(medium([review(1, 'maint1', 'APPROVED', APPROVED)], prOver), compare);
      const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
      assert.equal(r.pass, false);
    });
  }

  test('reports the in-diff file that blocked the carry', async () => {
    const gh = carryWorld(
      medium([review(1, 'maint1', 'APPROVED', APPROVED)], { files: [{ filename: 'docs/a.md' }, { filename: 'routing/r.go' }] }),
      { [APPROVED]: { files: ['docs/a.md', 'routing/r.go'] } },
    );
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.match(r.details.ignoredApprovals[0].why, /routing\/r.go changed since/);
  });

  test('does not call the compare API for approvals on the head', async () => {
    const gh = world(medium([review(1, 'maint1')]));
    await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.ok(!gh.calls.some((c) => c.includes('/compare/')));
  });
});

describe('fail closed on errors', () => {
  test('a 5xx while gathering inputs writes a failing check on the head', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), { errors: { 'GET /issues/7/timeline': 503 } });
    const e = env('pull_request_target', { pull_request: { number: 7, head: { sha: HEAD } } });
    await assert.rejects(run({ env: e, fetch: gh.fetch, log: quiet }), /503/);
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].head_sha, HEAD);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
    assert.match(gh.state.checkRuns[0].output.title, /could not evaluate PR #7/);
  });

  test('a missing PR on merge_group fails closed on the group head', async () => {
    const gh = world();
    delete gh.state.prs[7];
    await assert.rejects(run({ env: env('merge_group', groupEvent()), fetch: gh.fetch, log: quiet }), /404/);
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].head_sha, GROUP_SHA);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
  });

  test('a missing PR on pull_request_target falls back to the payload head', async () => {
    const gh = world();
    delete gh.state.prs[7];
    const sha = 'e'.repeat(40);
    const e = env('pull_request_target', { pull_request: { number: 7, head: { sha } } });
    await assert.rejects(run({ env: e, fetch: gh.fetch, log: quiet }), /404/);
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].head_sha, sha);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
  });

  test('a failing check that cannot be written still fails the run', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }), {
      errors: { 'GET /issues/7/timeline': 503, 'POST /check-runs': 503, [`GET /commits/${HEAD}/check-runs`]: 503 },
    });
    const e = env('pull_request_target', { pull_request: { number: 7, head: { sha: HEAD } } });
    await assert.rejects(run({ env: e, fetch: gh.fetch, log: quiet }), /503/);
  });
});

describe('shared head commit', () => {
  // PR #8 is a twin of #7: the same head commit, opened by someone else.
  const twin = (over = {}) => {
    const { pull: pullOver, ...rest } = over;
    return {
      pull: {
        number: 8,
        user: { login: 'outsider' },
        head: { sha: HEAD },
        base: { ref: 'master' },
        labels: [],
        changed_files: 1,
        ...pullOver,
      },
      files: [{ filename: 'docs/a.md' }],
      reviews: [],
      timeline: [],
      ...rest,
    };
  };
  const labeled = (name, actor) => ({ event: 'labeled', label: { name }, actor: { login: actor } });

  test("one PR's PASS cannot cover a stricter twin's FAIL", async () => {
    // #7's author applied its label themselves, so #7 has no counted
    // severity. The same label counts on #8, where they are not the
    // author. Both share the head; the strictest verdict is reported.
    const gh = world(
      prState({ labels: ['severity-low'], timeline: [labeled('severity-low', 'author')], reviews: [review(1, BOT)] }),
      { permissions: { maint1: 'write', maint2: 'admin', author: 'write' } },
    );
    gh.state.prs[8] = twin({
      pull: { labels: [{ name: 'severity-low' }] },
      timeline: [labeled('severity-low', 'author')],
      reviews: [review(2, BOT)],
    });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /head shared by #7, #8; strictest, from #7: needs severity/);
    assert.equal(gh.state.checkRuns.length, 1);
    assert.equal(gh.state.checkRuns[0].head_sha, HEAD);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
    assert.match(gh.state.checkRuns[0].output.summary, /Shared head \| #7, #8/);
  });

  test('an unlabeled twin fails an otherwise passing PR closed', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    gh.state.prs[8] = twin();
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, false);
    assert.match(r.reason, /strictest, from #8: needs severity/);
    assert.equal(gh.state.checkRuns[0].conclusion, 'failure');
  });

  test('when every PR sharing the head passes, the check passes', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    gh.state.prs[8] = twin({
      pull: { labels: [{ name: 'severity-low' }] },
      timeline: [labeled('severity-low', 'maint1')],
      reviews: [review(2, BOT)],
    });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, true, r.reason);
    assert.match(r.reason, /head shared by #7, #8, all passing/);
    assert.equal(gh.state.checkRuns[0].conclusion, 'success');
  });

  test('a twin on another branch is not fetched when heads differ', async () => {
    const gh = world(prState({ reviews: [review(1, BOT)] }));
    gh.state.prs[8] = twin({ pull: { head: { sha: 'f'.repeat(40) } } });
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, true, r.reason);
    assert.ok(!gh.calls.some((c) => c.includes('/pulls/8/')));
  });
});

describe('collaborator permission', () => {
  test('a maintainer on an org custom role counts via the legacy permission field', async () => {
    const gh = world(
      prState({
        labels: ['severity-high'],
        timeline: [{ event: 'labeled', label: { name: 'severity-high' }, actor: { login: 'coredev' } }],
        reviews: [review(1, 'coredev')],
      }),
      { permissions: { coredev: { permission: 'write', role_name: 'core-dev' } } },
    );
    const [r] = await run({ env: env('pull_request_target', { pull_request: { number: 7 } }), fetch: gh.fetch, log: quiet });
    assert.equal(r.pass, true, r.reason);
  });
});
