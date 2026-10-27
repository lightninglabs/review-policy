import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../src/github.mjs';
import { run, gatherInputs } from '../src/main.mjs';
import { fakeGitHub, API } from './fakegh.mjs';
import { README_CONFIG, HEAD, OLD, BOT } from './fixtures.mjs';

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
      { event: 'labeled', label: { name: 'severity-low' }, actor: { login: 'github-actions[bot]' } },
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
    const pr = prState({ labels: ['severity-medium'], timeline: [{ event: 'labeled', label: { name: 'severity-medium' }, actor: { login: 'github-actions[bot]' } }], reviews });
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
    const pr = prState({ labels: ['severity-medium'], timeline: [{ event: 'labeled', label: { name: 'severity-medium' }, actor: { login: 'github-actions[bot]' } }], reviews: [review(1, 'outsider')] });
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
    const input = await gatherInputs(client, REPO, 7);
    assert.deepEqual(input.permissions, { maint1: 'write' });
  });
});
