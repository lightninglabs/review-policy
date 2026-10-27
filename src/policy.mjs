// Policy evaluation. Everything here is pure: no I/O, no clock, no
// environment. The same inputs always give the same verdict.

import { CONFIG_PATH, SEVERITIES } from './config.mjs';
import { matchAny } from './glob.mjs';

// The account the severity classifier workflow applies labels as.
export const CLASSIFIER = 'github-actions[bot]';

const LABEL_RE = /^severity-(low|medium|high|critical)$/;
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
// Review states that do not change a reviewer's approval, as on GitHub.
const NEUTRAL_STATES = new Set(['COMMENTED', 'PENDING']);

const lc = (s) => String(s ?? '').toLowerCase();
const rank = (sev) => SEVERITIES.indexOf(sev);
const maxSeverity = (a, b) => (a === null ? b : b === null ? a : rank(a) >= rank(b) ? a : b);
const short = (sha) => String(sha ?? '').slice(0, 7);

export function hasWrite(permissions, login) {
  return WRITE_PERMISSIONS.has(permissions?.[lc(login)]);
}

// changedPaths returns every path the PR touches. A rename touches both
// its old and its new path.
export function changedPaths(files) {
  const out = new Set();
  for (const f of files ?? []) {
    if (typeof f === 'string') {
      out.add(f);
      continue;
    }
    if (f.filename) out.add(f.filename);
    if (f.previous_filename) out.add(f.previous_filename);
  }
  return [...out].sort();
}

// latestLabelers maps each severity label currently on the PR to the
// actor of its most recent "labeled" timeline event.
function latestLabelers(labels, timeline) {
  const current = new Set((labels ?? []).map(lc).filter((l) => LABEL_RE.test(l)));
  const actor = new Map();
  for (const ev of timeline ?? []) {
    const name = lc(ev.label);
    if (!current.has(name)) continue;
    if (ev.event === 'labeled') actor.set(name, ev.actor ?? null);
    else if (ev.event === 'unlabeled') actor.delete(name);
  }
  return [...current].sort().map((label) => ({ label, actor: actor.get(label) ?? null }));
}

// latestReviews keeps the most recent review per reviewer that changes
// its approval state. COMMENTED and PENDING reviews are skipped, as
// GitHub does.
function latestReviews(reviews) {
  const sorted = [...(reviews ?? [])].sort((a, b) => {
    const ta = a.submittedAt ?? '';
    const tb = b.submittedAt ?? '';
    if (ta !== tb) return ta < tb ? -1 : 1;
    return (a.id ?? 0) - (b.id ?? 0);
  });
  const latest = new Map();
  for (const r of sorted) {
    if (!r.user || NEUTRAL_STATES.has(r.state)) continue;
    latest.set(lc(r.user), r);
  }
  return [...latest.values()];
}

// actorsToCheck lists the logins whose repository permission the
// evaluation needs: severity labelers and approving reviewers that are
// not bots.
export function actorsToCheck(input) {
  const { config, labels, timeline, reviews, author } = input;
  const bots = new Set((config?.bots ?? []).map(lc));
  const out = new Set();
  for (const { actor } of latestLabelers(labels, timeline)) {
    if (actor && lc(actor) !== CLASSIFIER && lc(actor) !== lc(author)) out.add(lc(actor));
  }
  for (const r of latestReviews(reviews)) {
    const who = lc(r.user);
    if (r.state === 'APPROVED' && !bots.has(who) && who !== lc(author)) out.add(who);
  }
  return [...out].sort();
}

function fail(reason, details = {}, severity = null) {
  return { pass: false, severity, reason, details };
}

// evaluate decides whether a PR has the approvals its severity needs.
//
// input:
//   config       validated config (see config.mjs), or null
//   configError  why the config is missing or invalid, if it is
//   files        changed files: strings or {filename, previous_filename}
//   labels       names of the labels currently on the PR
//   timeline     label events, oldest first: {event, label, actor}
//   reviews      {id, user, state, commitId, submittedAt}
//   author       PR author login
//   headSha      the PR's current head commit
//   permissions  login (lower case) -> repository permission
//
// Returns {pass, severity, reason, details}.
export function evaluate(input) {
  const { config, configError, author, headSha, permissions = {} } = input;
  if (!config) {
    return fail(`invalid policy: ${configError || `${CONFIG_PATH} not found on the base branch`}`);
  }
  if (!headSha) return fail('no head commit');
  const listed = input.files?.length ?? 0;
  if (input.filesTotal != null && listed < input.filesTotal) {
    return fail(`cannot list every changed file (${listed} of ${input.filesTotal})`);
  }

  const bots = new Set(config.bots.map(lc));
  const authorLc = lc(author);
  const paths = changedPaths(input.files);
  const details = { headSha, author, paths: paths.length };

  // Severity from labels. A label counts only if the classifier or a
  // maintainer other than the author applied it most recently.
  const labelInfo = latestLabelers(input.labels, input.timeline).map(({ label, actor }) => {
    const sev = LABEL_RE.exec(label)[1];
    let why = null;
    if (!actor) why = 'no labeled event in the timeline';
    else if (lc(actor) === CLASSIFIER) why = null;
    else if (lc(actor) === authorLc) why = 'applied by the PR author';
    else if (!hasWrite(permissions, actor)) why = `applied by ${actor}, who lacks write access`;
    return { label, severity: sev, actor, counted: why === null, why };
  });
  details.labels = labelInfo;
  let labelSeverity = null;
  for (const l of labelInfo) if (l.counted) labelSeverity = maxSeverity(labelSeverity, l.severity);
  details.labelSeverity = labelSeverity;

  // Path floor.
  const configEdited = paths.includes(CONFIG_PATH);
  let floorSeverity = null;
  const floored = [];
  for (const p of paths) {
    let pf = p === CONFIG_PATH ? 'critical' : null;
    for (const sev of SEVERITIES) {
      if (matchAny(config.floor[sev], p)) pf = maxSeverity(pf, sev);
    }
    if (pf) {
      floored.push(p);
      floorSeverity = maxSeverity(floorSeverity, pf);
    }
  }
  details.floorSeverity = floorSeverity;
  details.flooredPaths = floored;
  details.configEdited = configEdited;

  if (!labelSeverity) {
    const ignored = labelInfo.filter((l) => !l.counted);
    const note = ignored.length
      ? ` (ignored: ${ignored.map((l) => `${l.label} ${l.why}`).join('; ')})`
      : '';
    return fail(`needs severity: no severity-* label applied by the classifier or a maintainer${note}`, details);
  }
  const severity = maxSeverity(labelSeverity, floorSeverity);
  const SEV = severity.toUpperCase();

  // Bot approvals are void if any path is never-auto-approve.
  const voidPaths = paths.filter((p) => p === CONFIG_PATH || matchAny(config.neverAutoApprove, p));
  details.botVoidPaths = voidPaths;

  // Expert author: every floored path must be inside their globs. The
  // PR must touch at least one floored path, and must not edit the
  // policy file.
  const expertGlobs = config.experts[authorLc];
  const expert =
    !!expertGlobs && !configEdited && floored.length > 0 && floored.every((p) => matchAny(expertGlobs, p));
  details.expert = expert;

  const tier = config.tiers[severity];
  const fresh = tier.fresh;
  const need = expert ? { humans: 0, bot: true } : { humans: tier.humans, bot: tier.bot };
  details.requirement = { ...need, fresh };

  // Approvals.
  const humans = [];
  const botApprovals = [];
  const ignored = [];
  for (const r of latestReviews(input.reviews)) {
    if (r.state !== 'APPROVED') continue;
    const who = r.user;
    const whoLc = lc(who);
    if (whoLc === authorLc) ignored.push({ login: who, why: 'PR author' });
    else if (fresh && r.commitId !== headSha) {
      ignored.push({ login: who, why: `approved ${short(r.commitId)}, not the head` });
    } else if (bots.has(whoLc)) {
      if (voidPaths.length) ignored.push({ login: who, why: 'bot approval void on never-auto-approve paths' });
      else botApprovals.push(who);
    } else if (!hasWrite(permissions, who)) ignored.push({ login: who, why: 'no write access' });
    else humans.push(who);
  }
  details.humanApprovals = humans;
  details.botApprovals = botApprovals;
  details.ignoredApprovals = ignored;

  const h = humans.length;
  const pass = h >= need.humans && (!need.bot || botApprovals.length > 0 || h >= need.humans + 1);

  const label = expert ? `${SEV} (expert author ${author})` : SEV;
  const where = fresh ? `on ${short(headSha)}` : `(head ${short(headSha)})`;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  let reason;
  if (!need.bot) {
    reason = `${label}: ${h} of ${plural(need.humans, 'human approval')} ${where}`;
  } else {
    const have = `${plural(h, 'human approval')}${botApprovals.length ? ' and the bot' : ''}`;
    if (pass) {
      reason = h === 0 ? `${label}: bot approval ${where}` : `${label}: ${have} ${where}`;
    } else {
      const want = need.humans
        ? `${plural(need.humans, 'human approval')} plus the bot or another human`
        : 'the bot or 1 human';
      const voidNote = voidPaths.length ? `; bot approval does not count for ${voidPaths[0]}` : '';
      reason = `${label}: needs ${want}, has ${have} ${where}${voidNote}`;
    }
  }
  return { pass, severity, reason, details };
}
