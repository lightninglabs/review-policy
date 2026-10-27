// GitHub I/O: gather the inputs for a PR, evaluate, and write the check.

import { readFileSync, appendFileSync } from 'node:fs';
import { CONFIG_PATH, parseConfig } from './config.mjs';
import { createClient } from './github.mjs';
import { evaluate, actorsToCheck } from './policy.mjs';

export const CHECK_NAME = 'review-policy';

// prNumbers works out which PRs an event is about.
export async function prNumbers(client, repo, eventName, event) {
  switch (eventName) {
    case 'pull_request_target':
    case 'pull_request':
    case 'pull_request_review':
      return [event.pull_request?.number].filter(Number.isInteger);
    case 'workflow_dispatch': {
      const v = String(event.inputs?.pr ?? '');
      if (!/^[1-9]\d*$/.test(v)) throw new Error('workflow_dispatch needs a numeric "pr" input');
      return [Number(v)];
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
      return [...nums].sort((a, b) => a - b);
    }
    default:
      throw new Error(`unsupported event "${eventName}"`);
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
    return d?.role_name || d?.permission || 'none';
  } catch (err) {
    if (err.status === 404) return 'none';
    throw err;
  }
}

// gatherInputs reads everything evaluate() needs from the API. The
// config comes from the base branch, never from the PR.
export async function gatherInputs(client, repo, number) {
  const pr = await client.request('GET', `/repos/${repo}/pulls/${number}`);
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
    permissions: {},
  };
  for (const login of actorsToCheck(input)) {
    input.permissions[login] = await permission(client, repo, login);
  }
  return input;
}

export function summarize(result) {
  const d = result.details ?? {};
  const lines = [`**${result.pass ? 'PASS' : 'FAIL'}:** ${result.reason}`, ''];
  const row = (k, v) => lines.push(`| ${k} | ${String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
  lines.push('| | |', '| --- | --- |');
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
    row('Needs', `${r.humans} human${r.humans === 1 ? '' : 's'}${r.bot ? ' + (bot or another human)' : ''}${r.fresh ? ', on the head commit' : ''}`);
  }
  if (d.humanApprovals) row('Human approvals', d.humanApprovals.join(', ') || 'none');
  if (d.botApprovals) row('Bot approvals', d.botApprovals.join(', ') || 'none');
  if (d.ignoredApprovals?.length) row('Ignored approvals', d.ignoredApprovals.map((i) => `${i.login} (${i.why})`).join('; '));
  return lines.join('\n').slice(0, 60000);
}

export async function writeCheck(client, repo, sha, result) {
  const body = {
    name: CHECK_NAME,
    head_sha: sha,
    status: 'completed',
    conclusion: result.pass ? 'success' : 'failure',
    completed_at: new Date().toISOString(),
    output: { title: result.reason.slice(0, 255), summary: summarize(result) },
  };
  const existing = await client.request('GET', `/repos/${repo}/commits/${sha}/check-runs`, {
    query: { check_name: CHECK_NAME, filter: 'latest', per_page: 100 },
  });
  const mine = (existing?.check_runs ?? []).find((c) => c.app?.slug === 'github-actions');
  if (mine) {
    const { name, head_sha, ...patch } = body;
    return client.request('PATCH', `/repos/${repo}/check-runs/${mine.id}`, { body: patch });
  }
  return client.request('POST', `/repos/${repo}/check-runs`, { body });
}

// run evaluates every PR the event refers to and writes one check run
// per PR head. It returns the results.
export async function run({ env = process.env, fetch = globalThis.fetch, log = console.log } = {}) {
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY is not set');
  const token = env.INPUT_TOKEN || env.GITHUB_TOKEN;
  const client = createClient({ token, apiUrl: env.GITHUB_API_URL || undefined, fetch });
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const numbers = await prNumbers(client, repo, env.GITHUB_EVENT_NAME, event);
  if (numbers.length === 0) log('review-policy: no pull request for this event');
  const results = [];
  for (const number of numbers) {
    const input = await gatherInputs(client, repo, number);
    const result = evaluate(input);
    await writeCheck(client, repo, input.headSha, result);
    log(`review-policy: #${number} ${result.pass ? 'PASS' : 'FAIL'}: ${result.reason}`);
    if (env.GITHUB_STEP_SUMMARY) {
      appendFileSync(env.GITHUB_STEP_SUMMARY, `### #${number}\n\n${summarize(result)}\n\n`);
    }
    results.push({ number, ...result });
  }
  return results;
}
