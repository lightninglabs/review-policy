import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.mjs';
import { README_CONFIG } from './fixtures.mjs';

test('README example validates and normalizes', () => {
  const c = parseConfig(README_CONFIG);
  assert.deepEqual(c.tiers, {
    low: { humans: 0, bot: true, fresh: false },
    medium: { humans: 1, bot: false, fresh: false },
    high: { humans: 1, bot: false, fresh: true },
    critical: { humans: 2, bot: false, fresh: true },
  });
  assert.deepEqual(c.floor.low, []);
  assert.deepEqual(c.experts.alice, ['htlcswitch/**', 'routing/**']);
});

const tiers = 'tiers:\n  low: {humans: 0, bot: true}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n';

test('minimal config', () => {
  const c = parseConfig(`version: 1\n${tiers}`);
  assert.deepEqual(c.bots, []);
  assert.deepEqual(c.experts, {});
});

for (const [name, src, re] of [
  ['empty file', '', /must be a mapping/],
  ['wrong version', `version: 2\n${tiers}`, /version must be 1/],
  ['missing version', tiers, /version must be 1/],
  ['unknown top-level key', `version: 1\nbot: [x]\n${tiers}`, /unknown key "bot"/],
  ['missing tier', 'version: 1\ntiers:\n  low: {humans: 0}\n  medium: {humans: 1}\n  high: {humans: 1}\n', /tiers.critical is required/],
  ['unknown tier', `version: 1\n${tiers}  extreme: {humans: 3}\n`, /unknown key "extreme"/],
  ['negative humans', 'version: 1\ntiers:\n  low: {humans: -1}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n', /non-negative integer/],
  ['string humans', 'version: 1\ntiers:\n  low: {humans: "0"}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n', /non-negative integer/],
  ['typo in tier key', 'version: 1\ntiers:\n  low: {humans: 0, fersh: true}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n', /unknown key "fersh"/],
  ['non-boolean fresh', 'version: 1\ntiers:\n  low: {humans: 0, fresh: yes}\n  medium: {humans: 1}\n  high: {humans: 1}\n  critical: {humans: 2}\n', /true or false/],
  ['floor not a list', `version: 1\nfloor:\n  high: "x/**"\n${tiers}`, /floor.high must be a list/],
  ['bad glob', `version: 1\nfloor:\n  high: ["a**/b"]\n${tiers}`, /whole path segment/],
  ['empty expert', `version: 1\nexperts:\n  bob: []\n${tiers}`, /at least one glob/],
  ['bad YAML', 'version: 1\n  x: 2', /cannot parse YAML/],
]) {
  test(`rejects ${name}`, () => assert.throws(() => parseConfig(src), re));
}
