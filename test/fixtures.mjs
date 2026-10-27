import { parseConfig } from '../src/config.mjs';

// The example policy from the README.
export const README_CONFIG = `version: 1

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
`;

export const config = parseConfig(README_CONFIG);
export const HEAD = 'abc1234def5678900000000000000000000000000';
export const OLD = '0ld0000000000000000000000000000000000000';
export const BOT = 'lightninglabs-gateway[bot]';

let reviewId = 0;
export function approve(user, commitId = HEAD, state = 'APPROVED') {
  reviewId++;
  return { id: reviewId, user, state, commitId, submittedAt: `2026-10-01T00:00:${String(reviewId).padStart(2, '0')}Z` };
}

// input builds a PR that by default is a docs change labeled
// severity-low by the classifier, authored by "author", with no reviews.
export function input(over = {}) {
  const sev = 'severity' in over ? over.severity : 'low';
  return {
    config,
    files: ['docs/readme.md'],
    labels: sev ? [`severity-${sev}`] : [],
    timeline: sev ? [{ event: 'labeled', label: `severity-${sev}`, actor: 'github-actions[bot]' }] : [],
    reviews: [],
    author: 'author',
    headSha: HEAD,
    permissions: { maint1: 'write', maint2: 'admin', maint3: 'maintain', reader: 'read', author: 'write', alice: 'write' },
    ...over,
  };
}
