# review-policy

A required GitHub status check that decides whether a pull request has the
approvals it needs, based on how risky the PR is.

The repository ruleset asks for one approval. This check raises that bar for
riskier PRs. It makes no model calls and never runs PR code, and it reaches
the same answer every time for the same inputs.

> **Status:** v1 implemented (tracked in
> [#1](https://github.com/lightninglabs/review-policy/issues/1)). Not yet
> deployed to any repository.

## The policy at a glance

| Severity | What it takes to merge |
| --- | --- |
| **LOW** | The bot approves after a clean Gateway review |
| **MEDIUM** | 1 human approval |
| **HIGH** | 1 human approval |
| **CRITICAL** | 2 different humans approve |
| **Expert author** | 1 human, or the bot, if every risky path the PR touches is in the author's listed domains |

The PR author never counts toward their own approvals.

## How the pieces fit

```mermaid
flowchart LR
    PR[Pull request] --> SEV[Severity classifier<br/>lnd pr-severity.yml]
    PR --> GW[Gateway review<br/>GitHub Actions]
    SEV -->|severity-* label| POL
    GW -->|findings + verdict| BOT[Claw review loop<br/>OpenClaw plugin]
    BOT -->|APPROVE or<br/>CHANGES_REQUESTED| POL
    HUM[Human reviewers] -->|APPROVE| POL
    CFG[.github/review-policy.yml<br/>from the base branch] --> POL
    POL{{review-policy check}} -->|pass / fail| RS[Ruleset:<br/>required status check]
    RS --> MERGE[Merge]
```

- **Severity classifier:** labels each PR's risk. A maintainer triggers it
  manually ([lnd#11424](https://github.com/lightningnetwork/lnd/issues/11424)).
- **Gateway:** reviews the code and reports findings.
- **Claw review loop:** follows Gateway through fixes, asks it to approve LOW
  PRs, and posts `CHANGES_REQUESTED` on higher tiers
  ([lightning-infra#4305](https://github.com/lightninglabs/lightning-infra/pull/4305)).
- **review-policy (this repo):** the gate. The bot's reviews are signals; this
  check is what makes the ruleset block or allow the merge.

## What the check decides

```mermaid
flowchart TD
    A[PR event or review event] --> B{Severity label set by<br/>classifier or maintainer?}
    B -- no --> F1[FAIL: needs severity]
    B -- yes --> C[Severity = max of label<br/>and path floor]
    C --> D{Touches a<br/>never-auto-approve path?}
    D -- yes --> E[Bot approval does not count]
    D -- no --> G
    E --> G[Count approvals on the<br/>current head commit]
    G --> H{Author is an expert for<br/>every risky path?}
    H -- yes --> I[Need: 1 human or the bot]
    H -- no --> J[Need: the tier's requirement]
    I --> K{Requirement met?}
    J --> K
    K -- yes --> P[PASS]
    K -- no --> F2[FAIL: e.g. CRITICAL,<br/>1 of 2 human approvals on abc1234]
```

## A PR's life

```mermaid
sequenceDiagram
    participant A as Author
    participant M as Maintainer
    participant S as Severity classifier
    participant G as Gateway
    participant C as Claw
    participant P as review-policy

    A->>A: opens PR
    P-->>A: FAIL, needs severity
    M->>S: adds the trigger label
    S->>A: severity-low
    C->>G: /gateway review
    G->>A: findings
    A->>A: pushes fixes
    C->>G: /gateway re-review
    G->>A: no open findings
    C->>G: /gateway approve
    G->>A: APPROVED on the head commit
    P-->>A: PASS, LOW with bot approval
    M->>A: merges, or the merge queue does
```

On a HIGH PR, the claw posts `CHANGES_REQUESTED` instead of asking Gateway to
approve, and the check stays red until a human approves the current head.

## Why a required check and not just bot reviews

A bot's `CHANGES_REQUESTED` review only blocks a merge if the bot is running
and noticed the PR. A required check **fails closed**:

- If the bot is down, the check never passes, so nothing merges.
- A PR with no severity fails with "needs severity".
- A severity label applied by the wrong person doesn't count.
- Approvals given on an older commit don't count for HIGH and CRITICAL.

## Configuration

Each repository keeps its policy in `.github/review-policy.yml`. The check
always reads it from the **base branch**, so a PR cannot loosen the rules that
judge it.

```yaml
version: 1

# Accounts whose approvals count as "the bot", never as humans.
bots:
  - lightninglabs-gateway[bot]

# Minimum severity by path. The final severity is never lower than this.
floor:
  critical: ["channeldb/migration*/**", "sqldb/**", "lnwallet/**", "contractcourt/**"]
  high: ["htlcswitch/**", "routing/**", "peer/**"]

# Paths where a bot approval never counts, whatever the severity.
never_auto_approve:
  - ".github/**"
  - "scripts/**"
  - "go.mod"
  - "go.sum"
  - "**/AGENTS.md"
  - "**/CLAUDE.md"

tiers:
  low:      { humans: 0, bot: true }
  medium:   { humans: 1 }
  high:     { humans: 1, fresh: true }   # fresh: approvals must be on the current head
  critical: { humans: 2, fresh: true }

# Authors with domain expertise. Their PRs need 1 human or the bot,
# but only when every floored path they touch is inside their globs.
experts:
  alice: ["htlcswitch/**", "routing/**"]
```

Changing `.github/review-policy.yml` itself is always treated as CRITICAL.

## Rules the check enforces

| Input | Rule |
| --- | --- |
| Severity label | Counts only if the timeline shows it was applied by the classifier workflow or by someone with write access other than the PR author |
| Path floor | Severity = the higher of the label and the floor |
| Approvals | The latest review per reviewer; only `APPROVED` counts. For `fresh` tiers, the review must be on the current head commit. |
| Humans vs bots | Accounts in `bots` count only as the bot. The PR author never counts. |
| Experts | Applies only if the expert is the PR author and every floored path the PR touches matches one of their globs |
| Never auto-approve | If any changed path matches, a bot approval satisfies nothing |

### Implementation details

Where the design above leaves room, v1 does this:

- **Labels** are `severity-low`, `-medium`, `-high`, `-critical`. If several
  valid ones are present, the highest wins. "The classifier workflow" is the
  `github-actions[bot]` account.
- **Approvers** must have write access to count as humans, as GitHub itself
  requires. `COMMENTED` reviews don't change a reviewer's latest state, as on
  GitHub; `CHANGES_REQUESTED` and dismissals do.
- **`bot: true`** on a tier adds one approval that the bot or another human can
  give. So LOW needs the bot or one human.
- **Experts** get relief only if the PR touches at least one floored path and
  doesn't edit the policy file.
- **The policy file** counts as a CRITICAL floored path and a
  never-auto-approve path, whatever the config says.
- **Globs** match whole paths: `**` is any number of directories, `*` and `?`
  stay inside one directory. A pattern without a slash, like `go.mod`, only
  matches at the root.
- **The config parser** is built in and accepts a strict YAML subset: block
  and flow mappings and lists, quoted and plain scalars, comments. Anchors,
  tags, and block scalars are errors. Unknown keys are errors, so a typo
  fails closed. Quote globs that start with `*`, and logins inside `[...]`
  lists, as YAML itself requires.
- **More than 3000 changed files**, the API's limit, fails the check.

## Using it in a repository

A workflow on `pull_request_target` runs the check. Review events can't run it
directly: for fork PRs, `pull_request_review` gets a read-only token, and it
runs the workflow file from the PR. A second workflow with no permissions
catches review events, and the first one runs on its completion through
`workflow_run`, from the default branch:

```yaml
# .github/workflows/review-policy.yml
name: review-policy
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled, unlabeled, ready_for_review]
  workflow_run:
    workflows: [review-policy-trigger]
    types: [completed]
  workflow_dispatch:
    inputs:
      pr: { description: PR number, required: true }
permissions:
  contents: read
  pull-requests: read
  checks: write
concurrency:
  group: review-policy-${{ github.event.pull_request.number || inputs.pr || github.event.workflow_run.head_sha }}
jobs:
  policy:  # don't name the job review-policy; that is the check's name
    runs-on: ubuntu-latest
    steps:
      - uses: lightninglabs/review-policy@<sha>
```

```yaml
# .github/workflows/review-policy-trigger.yml
name: review-policy-trigger
on:
  pull_request_review:
    types: [submitted, dismissed]
permissions: {}
jobs:
  trigger:
    runs-on: ubuntu-latest
    steps:
      - run: echo "re-evaluate review-policy"
```

Labels added with a workflow's `GITHUB_TOKEN` don't trigger other workflows,
so the severity classifier should re-run the check after it labels a PR:
`gh workflow run review-policy.yml -f pr=<number>` (needs `actions: write`).

Each run reads the PR's current state from the API, and writes one check run,
`review-policy`, on the current head commit.

This repository is **private**. Private consumers such as wavelength can use
the action directly once this repo's Actions access setting allows other org
repositories. Public repositories such as lnd cannot call a private action, so
they vendor a pinned copy of the script into their own `.github/` and update it
with a sync PR.

### Vendoring

`dist/review-policy.mjs` is the whole check in one file with no dependencies.
Copy it to `.github/review-policy.mjs` and replace the `uses:` step above with:

```yaml
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
          sparse-checkout: .github/review-policy.mjs
          sparse-checkout-cone-mode: false
          persist-credentials: false
      - run: node .github/review-policy.mjs
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

This checks out only the script, from the default branch, never PR code. It
needs Node 22 or later, which GitHub's runners have. The copy sits under
`.github/`, so a sync PR needs human approval.

## Development

```sh
node --test test/*.test.mjs   # unit and end-to-end tests, no network
node scripts/build.mjs        # rebuild dist/ after changing src/
```

`src/policy.mjs` is the pure evaluation; `src/main.mjs` does the GitHub I/O.
The tests fail if `dist/` is out of date.

Then, in the repository ruleset:

1. Add `review-policy` as a **required status check**, with the GitHub Actions
   integration as its source, so another App cannot report it.
2. In the same change, set required approvals to **1**. The check supplies the
   second approval for CRITICAL. Lowering the count first would leave a window
   where CRITICAL needs only one approval.

Roll it out as a non-required check first and compare its verdicts with real
merges before making it required.

## Open questions

- After a new push, do LOW and MEDIUM approvals carry over when the new commits
  are themselves LOW?
- Should the expert list be per repository, or one shared org file?
- Which account approves for the bot? It needs to be separate from
  `litbot-9000`, which also opens PRs and cannot approve its own.

## Related

- [lnd#11424](https://github.com/lightningnetwork/lnd/issues/11424): severity
  scoring, with a path floor and calibration
- [lightning-infra#4305](https://github.com/lightninglabs/lightning-infra/pull/4305):
  the claw review loop that drives Gateway
- [keybase-claw#42](https://github.com/lightninglabs/keybase-claw/issues/42):
  the umbrella tracker for engineering automation
