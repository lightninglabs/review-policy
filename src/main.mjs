// GitHub I/O: gather the inputs for a PR, evaluate, and write the check.

import { readFileSync, appendFileSync } from 'node:fs';
import { CONFIG_PATH, parseConfig } from './config.mjs';
import { createClient } from './github.mjs';
import { installationToken } from './app.mjs';
import { evaluate, actorsToCheck, staleApprovalCommits, ACTIONS_BOT } from './policy.mjs';

export const CHECK_NAME = 'review-policy';

export const SPOOF_WARNING =
  '> [!WARNING]\n' +
  '> Reported with `GITHUB_TOKEN`, not the review-policy App. Any workflow in this ' +
  'repository can create a check run with this name, so this result can be spoofed. ' +
  'Set the `app_id` and `private_key` inputs.';

// The compare API lists at most this many files.
const COMPARE_FILE_LIMIT = 300;

// parseMergeGroupRef reads the base branch and PR number from a merge
// queue ref, refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>. It
// returns null for anything else.
export function parseMergeGroupRef(ref) {
  const m = /^refs\/heads\/gh-readonly-queue\/(.+)\/pr-([1-9]\d*)-([0-9a-f]{40}|[0-9a-f]{64})$/.exec(String(ref ?? ''));
  if (!m || !Number.isSafeInteger(Number(m[2]))) return null;
  return { base: m[1], number: Number(m[2]), sha: m[3] };
}

// prTargets works out which PRs an event is about. Each target is
// {number}, plus for merge_group the commit to report on and the base
// branch the PR must target, and for workflow_run the run's head commit,
// so a failed run can still fail closed on it.
export async function prTargets(client, repo, eventName, event) {
  const nums = (list) => list.map((number) => ({ number }));
  switch (eventName) {
    case 'pull_request_target':
    case 'pull_request':
    case 'pull_request_review':
      return nums([event.pull_request?.number].filter(Number.isInteger));
    case 'workflow_dispatch': {
      const v = String(event.inputs?.pr ?? '');
      if (!/^[1-9]\d*$/.test(v)) throw new Error('workflow_dispatch needs a numeric "pr" input');
      return nums([Number(v)]);
    }
    case 'merge_group': {
      const group = event.merge_group ?? {};
      const parsed = parseMergeGroupRef(group.head_ref);
      if (!parsed) throw new MergeGroupError(`cannot read a PR number from merge group ref "${group.head_ref}"`);
      if (group.base_ref !== undefined && group.base_ref !== `refs/heads/${parsed.base}`) {
        throw new MergeGroupError(`merge group ref "${group.head_ref}" does not match base "${group.base_ref}"`);
      }
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(group.head_sha))) {
        throw new MergeGroupError('merge group has no head_sha');
      }
      return [{ number: parsed.number, reportSha: group.head_sha, base: parsed.base }];
    }
    case 'workflow_run': {
      // Fork PRs leave pull_requests empty, so also look the head commit
      // up among the open PRs. Each PR is then evaluated from the API, so
      // nothing in the triggering run is trusted.
      const run = event.workflow_run ?? {};
      const nums = new Set((run.pull_requests ?? []).map((p) => p.number).filter(Number.isInteger));
      if (run.head_sha) {
        const open = await client.paginate(`/repos/${repo}/pulls`, { query: { state: 'open' } });
        for (const p of open) if (p.head?.sha === run.head_sha) nums.add(p.number);
      }
      const headSha = HEX_SHA.test(String(run.head_sha)) ? String(run.head_sha) : undefined;
      return [...nums].sort((a, b) => a - b).map((number) => ({ number, headSha }));
    }
    default:
      throw new Error(`unsupported event "${eventName}"`);
  }
}

// MergeGroupError means a merge_group event names no PR the check can
// evaluate. The run reports a failure on the group's head commit.
export class MergeGroupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MergeGroupError';
  }
}

async function readConfig(client, repo, ref) {
  let data;
  try {
    data = await client.request('GET', `/repos/${repo}/contents/${CONFIG_PATH}`, { query: { ref } });
  } catch (err) {
    if (err.status === 404) return { configError: `${CONFIG_PATH} not found on ${ref}` };
    throw err;
  }
  if (data?.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
    return { configError: `${CONFIG_PATH} on ${ref} is not a readable file` };
  }
  try {
    return { config: parseConfig(Buffer.from(data.content, 'base64').toString('utf8')) };
  } catch (err) {
    return { configError: `${CONFIG_PATH} on ${ref}: ${err.message}` };
  }
}

async function permission(client, repo, login) {
  try {
    const d = await client.request('GET', `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`);
    // The legacy permission field already maps any role, including org
    // custom repository roles, onto admin/maintain/write/triage/read.
    // role_name would report the custom role's name instead, which is not
    // a known write permission.
    return d?.permission || d?.role_name || 'none';
  } catch (err) {
    if (err.status === 404) return 'none';
    throw err;
  }
}

// compareFiles lists the files changed from an approved commit to the
// head, or returns null if the API cannot compare them.
async function compareFiles(client, repo, base, head) {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(String(base))) return null;
  let d;
  try {
    d = await client.request('GET', `/repos/${repo}/compare/${base}...${head}`);
  } catch (err) {
    if (err.status === 404 || err.status === 422) return null;
    throw err;
  }
  if (!Array.isArray(d?.files)) return null;
  const files = d.files.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename }));
  return { status: d.status, files, complete: files.length < COMPARE_FILE_LIMIT };
}

// gatherInputs reads everything evaluate() needs from the API. The
// config comes from the base branch, never from the PR. If anything after
// the PR fetch itself fails, the error carries the PR's head commit, so
// the caller can still fail closed on it.
export async function gatherInputs(client, repo, number, { appLogin = null } = {}) {
  const pr = await client.request('GET', `/repos/${repo}/pulls/${number}`);
  try {
    const [cfg, files, timeline, reviews] = await Promise.all([
      readConfig(client, repo, pr.base.ref),
      client.paginate(`/repos/${repo}/pulls/${number}/files`),
      client.paginate(`/repos/${repo}/issues/${number}/timeline`),
      client.paginate(`/repos/${repo}/pulls/${number}/reviews`),
    ]);
    const input = {
      ...cfg,
      files: files.map((f) => ({ filename: f.filename, previous_filename: f.previous_filename })),
      filesTotal: pr.changed_files,
      labels: (pr.labels ?? []).map((l) => l.name),
      timeline: timeline
        .filter((e) => e.event === 'labeled' || e.event === 'unlabeled')
        .map((e) => ({ event: e.event, label: e.label?.name, actor: e.actor?.login })),
      reviews: reviews.map((r) => ({
        id: r.id,
        user: r.user?.login,
        state: r.state,
        commitId: r.commit_id,
        submittedAt: r.submitted_at,
      })),
      author: pr.user?.login,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      state: pr.state ?? 'open',
      appLogin,
      permissions: {},
      changesSince: {},
    };
    for (const login of actorsToCheck(input)) {
      input.permissions[login] = await permission(client, repo, login);
    }
    if (Object.values(input.config?.tiers ?? {}).some((t) => t.carry)) {
      for (const sha of staleApprovalCommits(input)) {
        input.changesSince[sha] = await compareFiles(client, repo, sha, input.headSha);
      }
    }
    return input;
  } catch (err) {
    if (err && typeof err === 'object' && !err.headSha && HEX_SHA.test(String(pr.head?.sha))) {
      err.headSha = pr.head.sha;
    }
    throw err;
  }
}

export function summarize(result, { spoofable = false } = {}) {
  const d = result.details ?? {};
  const lines = [];
  if (spoofable) lines.push(SPOOF_WARNING, '');
  lines.push(`**${result.pass ? 'PASS' : 'FAIL'}:** ${result.reason}`, '');
  const row = (k, v) => lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  lines.push('| | |', '| --- | --- |');
  if (d.mergeGroup) row('Merge group', `\`${d.mergeGroup.headSha}\`, evaluated as PR #${d.mergeGroup.number}`);
  if (d.sharedHead) row('Shared head', `${d.sharedHead.map((n) => `#${n}`).join(', ')}; strictest result reported`);
  if (d.headSha) row('Head', `\`${d.headSha}\``);
  if (d.author) row('Author', d.author);
  if (result.severity) row('Severity', result.severity.toUpperCase());
  if (d.labels) {
    row('Labels', d.labels.map((l) => `${l.label} by ${l.actor ?? '?'}${l.counted ? '' : ` (ignored: ${l.why})`}`).join('; ') || 'none');
  }
  if (d.floorSeverity) row('Path floor', `${d.floorSeverity.toUpperCase()}: ${d.flooredPaths.slice(0, 20).join(', ')}${d.flooredPaths.length > 20 ? ', …' : ''}`);
  if (d.configEdited) row('Policy file', `${CONFIG_PATH} changed: CRITICAL, bot approval void, no expert rule`);
  if (d.botVoidPaths?.length) row('Bot approval void', d.botVoidPaths.slice(0, 20).join(', '));
  if (d.expert !== undefined) row('Expert rule', d.expert ? 'applies' : 'does not apply');
  if (d.requirement) {
    const r = d.requirement;
    const extra = r.total > r.humans ? ' + (bot or another human)' : '';
    const when = r.fresh ? ', on the head commit' : r.carry === 'low_only' ? ', older approvals carry past low-risk changes only' : '';
    row('Needs', `${r.humans} human${r.humans === 1 ? '' : 's'}${extra}${when}; bot only on the head commit`);
  }
  if (d.humanApprovals) row('Human approvals', d.humanApprovals.join(', ') || 'none');
  if (d.carriedApprovals?.length) row('Carried from older commits', d.carriedApprovals.join(', '));
  if (d.botApprovals) row('Bot approvals', d.botApprovals.join(', ') || 'none');
  if (d.ignoredApprovals?.length) row('Ignored approvals', d.ignoredApprovals.map((i) => `${i.login} (${i.why})`).join('; '));
  return lines.join('\n').slice(0, 60000);
}

// writeCheck creates the check run on sha, or updates the one this App
// already created there. slug names the App the token belongs to.
export async function writeCheck(client, repo, sha, result, { slug = 'github-actions', spoofable = false } = {}) {
  const body = {
    name: CHECK_NAME,
    head_sha: sha,
    status: 'completed',
    conclusion: result.pass ? 'success' : 'failure',
    completed_at: new Date().toISOString(),
    output: { title: result.reason.slice(0, 255), summary: summarize(result, { spoofable }) },
  };
  const existing = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs`, {
    query: { check_name: CHECK_NAME, filter: 'latest', per_page: 100 },
  });
  const mine = (existing?.check_runs ?? []).find((c) => c.app?.slug === slug);
  if (mine) {
    const { name, head_sha, ...patch } = body;
    return client.request('PATCH', `/repos/${repo}/check-runs/${mine.id}`, { body: patch });
  }
  return client.request('POST', `/repos/${repo}/check-runs`, { body });
}

// authenticate picks the token to use. With app_id and private_key it
// mints an installation token for the review-policy App. Without them it
// falls back to GITHUB_TOKEN, whose check runs any workflow can forge.
async function authenticate(env, repo, fetch, log) {
  const apiUrl = env.GITHUB_API_URL || undefined;
  const appId = String(env.INPUT_APP_ID ?? '').trim();
  const privateKey = String(env.INPUT_PRIVATE_KEY ?? '');
  if (appId || privateKey.trim()) {
    if (!appId) throw new Error('private_key is set but app_id is empty');
    if (!privateKey.trim()) {
      throw new Error('app_id is set but private_key is empty; the key is only available to jobs in its environment, from the default branch');
    }
    const minted = await installationToken({ appId, privateKey, repo, apiUrl, fetch });
    log(`::add-mask::${minted.token}`);
    return { ...minted, apiUrl, spoofable: false };
  }
  log('::warning::review-policy: no app_id/private_key; reporting with GITHUB_TOKEN, so the check can be spoofed');
  return { token: env.INPUT_TOKEN || env.GITHUB_TOKEN, slug: 'github-actions', login: ACTIONS_BOT, apiUrl, spoofable: true };
}

// evaluateSharedHead evaluates the target PR plus every other open PR
// with the same head commit and returns the strictest result. The verdict
// is per PR — author, labels, reviews, and base branch all feed it — but
// the check run is keyed by head SHA, so two PRs sharing a head would
// otherwise overwrite each other's result: a looser PR could PASS over a
// stricter one's FAIL, and anyone could open an unlabeled twin to write
// FAIL over a PASS. Reporting the strictest fails closed in both
// directions.
//
// A closed target PR (say the event is pull_request_target "closed") is
// left out of the verdict: it is not going anywhere, and its result must
// not drag down the open PRs that share its head. When no open PR is left
// on the head there is nothing the check can protect, and null is
// returned.
async function evaluateSharedHead(client, repo, open, number, input, appLogin) {
  const twins = open.filter((p) => p.number !== number && p.head?.sha === input.headSha);
  const closed = input.state !== 'open';
  if (twins.length === 0) return closed ? null : evaluate(input);
  const verdicts = [];
  if (!closed) verdicts.push({ number, result: evaluate(input) });
  for (const twin of twins) {
    const twinInput = await gatherInputs(client, repo, twin.number, { appLogin });
    verdicts.push({ number: twin.number, result: evaluate(twinInput) });
  }
  verdicts.sort((a, b) => a.number - b.number);
  const failing = verdicts.filter((v) => !v.result.pass);
  const sharedHead = verdicts.map((v) => v.number);
  const asList = sharedHead.map((n) => `#${n}`).join(', ') + (closed ? ` (#${number} closed)` : '');
  if (failing.length > 0) {
    const strictest = failing[0];
    const others = failing.length > 1 ? ` (${failing.length - 1} more failing)` : '';
    return {
      ...strictest.result,
      reason: `head shared by ${asList}; strictest, from #${strictest.number}${others}: ${strictest.result.reason}`,
      details: { ...strictest.result.details, sharedHead },
    };
  }
  const own = closed ? verdicts[0] : verdicts.find((v) => v.number === number);
  return {
    ...own.result,
    reason: `head shared by ${asList}, all passing; #${own.number}: ${own.result.reason}`,
    details: { ...own.result.details, sharedHead },
  };
}

// A SHA the event payload names, valid to report a failure on when the
// event cannot be read at all.
const HEX_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

// run evaluates every PR the event refers to and writes one check run
// per PR head, or on the merge group's head for merge_group. It returns
// the results. Every error path first tries to write a failing check on
// the relevant commit, so an earlier PASS cannot stand in for a run that
// never finished.
export async function run({ env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is not set');
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const auth = await authenticate(env, repo, fetch, log);
  const client = createClient({ token: auth.token, apiUrl: auth.apiUrl, fetch });
  // Labels count when this login applied them. It defaults to the App
  // the token belongs to; github-actions[bot] never counts.
  const appLogin = String(env.INPUT_APP_LOGIN ?? '').trim() || auth.login;
  const report = { slug: auth.slug, spoofable: auth.spoofable };
  const summary = (title, result) => {
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${summarize(result, report)}\n\n`);
    }
  };
  // failClosed writes a failing check on sha, swallowing any error of its
  // own: the original error is the one the run rethrows.
  const failClosed = async (sha, message) => {
    const result = { pass: false, severity: null, reason: message, details: {} };
    try {
      await writeCheck(client, repo, sha, result, report);
      summary(`fail closed ${sha.slice(0, 7)}`, result);
    } catch {
      // Nothing more can be reported; the run still fails.
    }
  };
  try {
    let targets;
    try {
      targets = await prTargets(client, repo, env.GITHUB_EVENT_NAME, event);
    } catch (err) {
      // Fail closed on every commit the payload names: a queue entry or
      // PR the check cannot read gets a failing check rather than none.
      const shas = [event.merge_group?.head_sha, event.pull_request?.head?.sha, event.workflow_run?.head_sha];
      for (const sha of new Set(shas.filter((s) => HEX_SHA.test(String(s))))) {
        await failClosed(String(sha), err.message);
      }
      throw err;
    }
    if (targets.length === 0) log('review-policy: no pull request for this event');
    const results = [];
    // Open PRs are listed lazily, once, so every PR sharing a head commit
    // can be evaluated together. merge_group reports on its own head and
    // does not need the list.
    let open = null;
    for (const { number, reportSha, base, headSha } of targets) {
      let input;
      try {
        input = await gatherInputs(client, repo, number, { appLogin });
        let result;
        if (reportSha === undefined) {
          open ??= await client.paginate(`/repos/${repo}/pulls`, { query: { state: 'open', per_page: 100 } });
          result = await evaluateSharedHead(client, repo, open, number, input, appLogin);
        } else {
          result = evaluate(input);
        }
        if (result === null) {
          log(`review-policy: #${number} is closed and no open PR shares its head; nothing to report`);
          continue;
        }
        if (base !== undefined && input.baseRef !== base) {
          result = { ...result, pass: false, reason: `PR #${number} targets ${input.baseRef}, not the merge group's base ${base}` };
        }
        if (reportSha) result.details = { ...result.details, mergeGroup: { headSha: reportSha, number } };
        await writeCheck(client, repo, reportSha ?? input.headSha, result, report);
        log(`review-policy: #${number} ${result.pass ? 'PASS' : 'FAIL'}: ${result.reason}`);
        summary(`#${number}`, result);
        results.push({ number, ...result });
      } catch (err) {
        const payloadSha = event.pull_request?.number === number ? event.pull_request?.head?.sha : null;
        const sha = reportSha ?? input?.headSha ?? err?.headSha ?? headSha ?? payloadSha;
        if (HEX_SHA.test(String(sha))) {
          await failClosed(String(sha), `could not evaluate PR #${number}: ${err.message}`);
        }
        throw err;
      }
    }
    return results;
  } finally {
    // An installation token lives an hour; revoke it once done.
    if (!auth.spoofable) await client.request('DELETE', '/installation/token').catch(() => {});
  }
}
