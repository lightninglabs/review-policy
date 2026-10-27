import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, actorsToCheck } from '../src/policy.mjs';
import { parseConfig } from '../src/config.mjs';
import { config, input, approve, HEAD, OLD, BOT, README_CONFIG } from './fixtures.mjs';

const lab = (label, actor, event = 'labeled') => ({ event, label, actor });

describe('fail closed', () => {
  test('missing config fails', () => {
    const r = evaluate(input({ config: null, configError: '.github/review-policy.yml not found on main' }));
    assert.equal(r.pass, false);
    assert.match(r.reason, /^invalid policy: .*not found on main/);
  });

  test('no config and no error still fails', () => {
    const r = evaluate(input({ config: undefined }));
    assert.equal(r.pass, false);
    assert.match(r.reason, /not found/);
  });

  test('no severity label fails with "needs severity"', () => {
    const r = evaluate(input({ severity: null, reviews: [approve('maint1'), approve('maint2')] }));
    assert.equal(r.pass, false);
    assert.equal(r.severity, null);
    assert.match(r.reason, /^needs severity/);
  });

  test('a path floor alone does not supply a severity', () => {
    const r = evaluate(input({ severity: null, files: ['lnwallet/a.go'], reviews: [approve('maint1'), approve('maint2')] }));
    assert.equal(r.pass, false);
    assert.match(r.reason, /^needs severity/);
  });

  test('unknown severity-* label is not a severity', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-extreme'], timeline: [lab('severity-extreme', 'maint1')] }));
    assert.match(r.reason, /^needs severity/);
  });

  test('incomplete file list fails', () => {
    const r = evaluate(input({ filesTotal: 3001, files: ['a'] }));
    assert.equal(r.pass, false);
    assert.match(r.reason, /cannot list every changed file \(1 of 3001\)/);
  });
});

describe('rule: severity label', () => {
  test('applied by the classifier counts', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1')] }));
    assert.equal(r.severity, 'medium');
    assert.equal(r.pass, true);
  });

  test('applied by a write-access maintainer counts', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-medium'], timeline: [lab('severity-medium', 'maint1')], reviews: [approve('maint2')] }));
    assert.equal(r.severity, 'medium');
    assert.equal(r.pass, true);
  });

  test('applied by the PR author is ignored, even with write access', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-low'], timeline: [lab('severity-low', 'author')], reviews: [approve(BOT)] }));
    assert.equal(r.pass, false);
    assert.match(r.reason, /^needs severity.*severity-low applied by the PR author/);
  });

  test('author cannot lower a classifier label by adding a lower one', () => {
    const r = evaluate(input({
      severity: null,
      labels: ['severity-high', 'severity-low'],
      timeline: [lab('severity-high', 'github-actions[bot]'), lab('severity-low', 'author')],
      reviews: [approve(BOT)],
    }));
    assert.equal(r.severity, 'high');
    assert.equal(r.pass, false);
  });

  test('applied by a user without write access is ignored', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-low'], timeline: [lab('severity-low', 'reader')] }));
    assert.match(r.reason, /reader, who lacks write access/);
  });

  test('applied by an unknown user is ignored', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-low'], timeline: [lab('severity-low', 'stranger')] }));
    assert.match(r.reason, /^needs severity/);
  });

  test('latest application wins: maintainer then author re-applies', () => {
    const r = evaluate(input({
      severity: null,
      labels: ['severity-low'],
      timeline: [lab('severity-low', 'maint1'), lab('severity-low', 'maint1', 'unlabeled'), lab('severity-low', 'author')],
    }));
    assert.match(r.reason, /^needs severity/);
  });

  test('latest application wins: author then maintainer re-applies', () => {
    const r = evaluate(input({
      severity: null,
      labels: ['severity-low'],
      timeline: [lab('severity-low', 'author'), lab('severity-low', 'author', 'unlabeled'), lab('severity-low', 'maint1')],
      reviews: [approve(BOT)],
    }));
    assert.equal(r.pass, true);
  });

  test('a removed label does not count', () => {
    const r = evaluate(input({
      severity: null,
      labels: [],
      timeline: [lab('severity-critical', 'maint1'), lab('severity-critical', 'maint1', 'unlabeled')],
    }));
    assert.match(r.reason, /^needs severity/);
  });

  test('a label with no timeline event does not count', () => {
    const r = evaluate(input({ severity: null, labels: ['severity-low'], timeline: [] }));
    assert.match(r.reason, /no labeled event/);
  });

  test('several valid labels: the highest wins', () => {
    const r = evaluate(input({
      severity: null,
      labels: ['severity-low', 'severity-critical'],
      timeline: [lab('severity-low', 'github-actions[bot]'), lab('severity-critical', 'maint1')],
    }));
    assert.equal(r.severity, 'critical');
  });

  test('label names are case-insensitive', () => {
    const r = evaluate(input({ severity: null, labels: ['Severity-Medium'], timeline: [lab('severity-medium', 'maint1')], reviews: [approve('maint2')] }));
    assert.equal(r.severity, 'medium');
  });
});

describe('rule: path floor', () => {
  test('floor raises a low label', () => {
    const r = evaluate(input({ files: ['htlcswitch/switch.go'], reviews: [approve(BOT)] }));
    assert.equal(r.severity, 'high');
    assert.equal(r.pass, false);
    assert.match(r.reason, /^HIGH: 0 of 1 human approval on abc1234$/);
  });

  test('floor never lowers a label', () => {
    const r = evaluate(input({ severity: 'critical', files: ['htlcswitch/switch.go'], reviews: [approve('maint1')] }));
    assert.equal(r.severity, 'critical');
  });

  test('highest floor across files wins', () => {
    const r = evaluate(input({ files: ['routing/a.go', 'channeldb/migration33/m.go', 'docs/x.md'] }));
    assert.equal(r.severity, 'critical');
    assert.deepEqual(r.details.flooredPaths, ['channeldb/migration33/m.go', 'routing/a.go']);
  });

  test('a rename out of a floored path is floored', () => {
    const r = evaluate(input({ files: [{ filename: 'misc/wallet.go', previous_filename: 'lnwallet/wallet.go' }] }));
    assert.equal(r.severity, 'critical');
  });

  test('non-matching paths keep the label', () => {
    const r = evaluate(input({ files: ['channeldb/graph.go', 'lnwallet2/x.go'], reviews: [approve(BOT)] }));
    assert.equal(r.severity, 'low');
    assert.equal(r.pass, true);
  });
});

describe('rule: policy file edit', () => {
  const files = ['.github/review-policy.yml'];

  test('is always CRITICAL', () => {
    const r = evaluate(input({ files, reviews: [approve('maint1')] }));
    assert.equal(r.severity, 'critical');
    assert.equal(r.details.configEdited, true);
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
  });

  test('is CRITICAL even when the config has no floor or never_auto_approve', () => {
    const bare = parseConfig('version: 1\nbots: [x]\ntiers:\n  low: {humans: 0, bot: true}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n');
    const r = evaluate(input({ config: bare, files, reviews: [approve('x'), approve('maint1')] }));
    assert.equal(r.severity, 'critical');
    assert.deepEqual(r.details.botApprovals, []);
    assert.equal(r.pass, false);
  });

  test('passes with two fresh humans', () => {
    const r = evaluate(input({ files, reviews: [approve('maint1'), approve('maint2')] }));
    assert.equal(r.pass, true);
  });

  test('disables the expert rule', () => {
    const cfg = parseConfig(README_CONFIG.replace('alice: ["htlcswitch/**", "routing/**"]', 'alice: ["**"]'));
    const r = evaluate(input({ config: cfg, author: 'alice', files: [...files, 'routing/a.go'], reviews: [approve('maint1')] }));
    assert.equal(r.details.expert, false);
    assert.equal(r.pass, false);
  });
});

describe('rule: approvals', () => {
  test('only the latest review per reviewer counts', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1'), approve('maint1', HEAD, 'CHANGES_REQUESTED')] }));
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'MEDIUM: 0 of 1 human approval (head abc1234)');
  });

  test('a later approval overrides earlier changes requested', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1', HEAD, 'CHANGES_REQUESTED'), approve('maint1')] }));
    assert.equal(r.pass, true);
  });

  test('a dismissed approval does not count', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1', HEAD, 'DISMISSED')] }));
    assert.equal(r.pass, false);
  });

  test('a COMMENTED review after an approval keeps the approval', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1'), approve('maint1', HEAD, 'COMMENTED')] }));
    assert.equal(r.pass, true);
  });

  test('reviews are ordered by time, not array order', () => {
    const later = { ...approve('maint1', HEAD, 'CHANGES_REQUESTED'), submittedAt: '2026-10-02T00:00:00Z' };
    const r = evaluate(input({ severity: 'medium', reviews: [later, approve('maint1')] }));
    assert.equal(r.pass, false);
  });

  test('two approvals from one person count once', () => {
    const r = evaluate(input({ severity: 'critical', reviews: [approve('maint1'), approve('maint1')] }));
    assert.equal(r.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
  });

  test('approvals from users without write access do not count', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('reader'), approve('stranger')] }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.details.ignoredApprovals.map((i) => i.why), ['no write access', 'no write access']);
  });

  test('reviewer logins are case-insensitive', () => {
    const r = evaluate(input({ severity: 'critical', reviews: [approve('Maint1'), approve('maint1')] }));
    assert.equal(r.details.humanApprovals.length, 1);
  });
});

describe('rule: fresh vs carried approvals', () => {
  test('MEDIUM (not fresh): an approval on an older commit carries', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('maint1', OLD)] }));
    assert.equal(r.pass, true);
  });

  test('LOW (not fresh): a bot approval on an older commit carries', () => {
    const r = evaluate(input({ reviews: [approve(BOT, OLD)] }));
    assert.equal(r.pass, true);
  });

  test('HIGH (fresh): an approval on an older commit does not count', () => {
    const r = evaluate(input({ severity: 'high', reviews: [approve('maint1', OLD)] }));
    assert.equal(r.pass, false);
    assert.match(r.details.ignoredApprovals[0].why, /not the head/);
  });

  test('CRITICAL (fresh): one fresh and one stale approval is not enough', () => {
    const r = evaluate(input({ severity: 'critical', reviews: [approve('maint1'), approve('maint2', OLD)] }));
    assert.equal(r.pass, false);
    assert.equal(r.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
  });

  test('fresh: re-approving the head counts', () => {
    const r = evaluate(input({ severity: 'high', reviews: [approve('maint1', OLD), approve('maint1')] }));
    assert.equal(r.pass, true);
  });
});

describe('rule: humans vs bots', () => {
  test('a bot approval never counts as a human', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve(BOT)] }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.details.humanApprovals, []);
  });

  test('a bot approval does not count even if the bot has write access', () => {
    const r = evaluate(input({ severity: 'critical', reviews: [approve(BOT), approve('maint1')], permissions: { [BOT]: 'admin', maint1: 'write' } }));
    assert.equal(r.pass, false);
  });

  test('author self-approval is ignored', () => {
    const r = evaluate(input({ severity: 'medium', reviews: [approve('author')] }));
    assert.equal(r.pass, false);
    assert.deepEqual(r.details.ignoredApprovals, [{ login: 'author', why: 'PR author' }]);
  });

  test('author self-approval is ignored for CRITICAL', () => {
    const r = evaluate(input({ severity: 'critical', reviews: [approve('author'), approve('maint1')] }));
    assert.equal(r.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
  });

  test('a bot that authored the PR cannot approve it', () => {
    const r = evaluate(input({ author: BOT, reviews: [approve(BOT)] }));
    assert.equal(r.pass, false);
  });
});

describe('rule: never auto-approve', () => {
  for (const path of ['.github/workflows/ci.yml', 'scripts/x.sh', 'go.mod', 'go.sum', 'AGENTS.md', 'lnrpc/AGENTS.md', 'a/b/CLAUDE.md']) {
    test(`bot approval void for ${path}`, () => {
      const r = evaluate(input({ files: ['docs/x.md', path], reviews: [approve(BOT)] }));
      assert.equal(r.pass, false);
      assert.match(r.reason, /bot approval does not count for/);
    });
  }

  test('go.mod outside the root is not matched by "go.mod"', () => {
    const r = evaluate(input({ files: ['tools/go.mod'], reviews: [approve(BOT)] }));
    assert.equal(r.pass, true);
  });

  test('a human can still approve a LOW PR on those paths', () => {
    const r = evaluate(input({ files: ['go.mod'], reviews: [approve(BOT), approve('maint1')] }));
    assert.equal(r.pass, true);
  });
});

describe('tier table', () => {
  const cases = [
    // severity, reviews, pass
    ['low', [], false],
    ['low', [approve(BOT)], true],
    ['low', [approve('maint1')], true],
    ['medium', [], false],
    ['medium', [approve(BOT)], false],
    ['medium', [approve('maint1')], true],
    ['high', [approve(BOT)], false],
    ['high', [approve('maint1')], true],
    ['critical', [approve('maint1')], false],
    ['critical', [approve('maint1'), approve(BOT)], false],
    ['critical', [approve('maint1'), approve('maint3')], true],
  ];
  for (const [sev, reviews, pass] of cases) {
    test(`${sev} with [${reviews.map((r) => r.user).join(', ')}] -> ${pass ? 'pass' : 'fail'}`, () => {
      const r = evaluate(input({ severity: sev, reviews }));
      assert.equal(r.severity, sev);
      assert.equal(r.pass, pass, r.reason);
    });
  }

  test('reason strings', () => {
    assert.equal(evaluate(input({ reviews: [approve(BOT)] })).reason, 'LOW: bot approval (head abc1234)');
    assert.equal(evaluate(input({ reviews: [] })).reason, 'LOW: needs the bot or 1 human, has 0 human approvals (head abc1234)');
    assert.equal(evaluate(input({ severity: 'critical', reviews: [approve('maint1'), approve('maint2')] })).reason, 'CRITICAL: 2 of 2 human approvals on abc1234');
  });

  test('bot: true with humans > 0 needs the humans plus the bot or another human', () => {
    const cfg = { ...config, tiers: { ...config.tiers, medium: { humans: 1, bot: true, fresh: false } } };
    assert.equal(evaluate(input({ config: cfg, severity: 'medium', reviews: [approve('maint1')] })).pass, false);
    assert.equal(evaluate(input({ config: cfg, severity: 'medium', reviews: [approve(BOT)] })).pass, false);
    assert.equal(evaluate(input({ config: cfg, severity: 'medium', reviews: [approve('maint1'), approve(BOT)] })).pass, true);
    assert.equal(evaluate(input({ config: cfg, severity: 'medium', reviews: [approve('maint1'), approve('maint2')] })).pass, true);
  });
});

describe('rule: experts', () => {
  const alice = (over) => input({ author: 'alice', severity: 'high', ...over });

  test('expert author, every floored path in their domain: bot is enough', () => {
    const r = alice({ files: ['htlcswitch/a.go', 'routing/b.go', 'docs/c.md'], reviews: [approve(BOT)] });
    const v = evaluate(r);
    assert.equal(v.details.expert, true);
    assert.equal(v.pass, true);
    assert.equal(v.reason, 'HIGH (expert author alice): bot approval on abc1234');
  });

  test('expert author: one human is enough even for CRITICAL label', () => {
    const v = evaluate(alice({ severity: 'critical', files: ['htlcswitch/a.go'], reviews: [approve('maint1')] }));
    assert.equal(v.pass, true);
  });

  test('expert rule keeps the tier freshness', () => {
    const v = evaluate(alice({ files: ['htlcswitch/a.go'], reviews: [approve(BOT, OLD)] }));
    assert.equal(v.pass, false);
  });

  test('partial domain match does NOT qualify', () => {
    const v = evaluate(alice({ files: ['htlcswitch/a.go', 'peer/brontide.go'], reviews: [approve(BOT)] }));
    assert.equal(v.details.expert, false);
    assert.equal(v.pass, false);
  });

  test('a CRITICAL floor outside the domain does NOT qualify', () => {
    const v = evaluate(alice({ files: ['routing/a.go', 'lnwallet/x.go'], reviews: [approve('maint1')] }));
    assert.equal(v.details.expert, false);
    assert.equal(v.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
  });

  test('expert reviewing someone else\'s PR gets no relief', () => {
    const v = evaluate(input({ author: 'bob', severity: 'high', files: ['htlcswitch/a.go'], reviews: [approve('alice', OLD), approve(BOT)], permissions: { alice: 'write' } }));
    assert.equal(v.details.expert, false);
    assert.equal(v.pass, false);
  });

  test('expert with no floored paths gets no relief', () => {
    const v = evaluate(alice({ files: ['docs/a.md'], reviews: [approve(BOT)] }));
    assert.equal(v.details.expert, false);
    assert.equal(v.pass, false);
  });

  test('never-auto-approve voids the bot for an expert too', () => {
    const v = evaluate(alice({ files: ['htlcswitch/a.go', 'go.mod'], reviews: [approve(BOT)] }));
    assert.equal(v.details.expert, true);
    assert.equal(v.pass, false);
    const v2 = evaluate(alice({ files: ['htlcswitch/a.go', 'go.mod'], reviews: [approve('maint1')] }));
    assert.equal(v2.pass, true);
  });

  test('expert self-approval is ignored', () => {
    const v = evaluate(alice({ files: ['htlcswitch/a.go'], reviews: [approve('alice')] }));
    assert.equal(v.pass, false);
  });

  test('expert login is case-insensitive', () => {
    const v = evaluate(input({ author: 'Alice', severity: 'high', files: ['routing/a.go'], reviews: [approve(BOT)] }));
    assert.equal(v.details.expert, true);
  });
});

describe('actorsToCheck', () => {
  test('lists non-bot labelers and approvers, not the author or classifier', () => {
    const got = actorsToCheck(input({
      labels: ['severity-low', 'severity-high'],
      timeline: [lab('severity-low', 'github-actions[bot]'), lab('severity-high', 'Maint1')],
      reviews: [approve('maint2'), approve(BOT), approve('author'), approve('x', HEAD, 'CHANGES_REQUESTED')],
    }));
    assert.deepEqual(got, ['maint1', 'maint2']);
  });
});

test('evaluate is deterministic', () => {
  const i = input({ severity: 'critical', files: ['b', 'a', 'lnwallet/x'], reviews: [approve('maint2'), approve('maint1')] });
  assert.deepEqual(evaluate(i), evaluate(structuredClone(i)));
});
