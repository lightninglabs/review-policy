// The bundled script must match src/ and behave the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dist from '../dist/review-policy.mjs';
import { input, approve, BOT } from './fixtures.mjs';

const root = new URL('../', import.meta.url).pathname;

test('dist/review-policy.mjs is up to date with src/', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rp-build-'));
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  cpSync(join(root, 'scripts'), join(dir, 'scripts'), { recursive: true });
  cpSync(join(root, 'dist'), join(dir, 'dist'), { recursive: true });
  execFileSync(process.execPath, [join(dir, 'scripts/build.mjs')]);
  assert.equal(readFileSync(join(dir, 'dist/review-policy.mjs'), 'utf8'), readFileSync(join(root, 'dist/review-policy.mjs'), 'utf8'), 'run: node scripts/build.mjs');
});

test('dist evaluates like src', () => {
  const cfg = dist.parseConfig(readFileSync(join(root, 'test/fixtures.mjs'), 'utf8').match(/README_CONFIG = `([^`]*)`/)[1]);
  const r = dist.evaluate(input({ config: cfg, severity: 'critical', reviews: [approve('maint1'), approve(BOT)] }));
  assert.equal(r.reason, 'CRITICAL: 1 of 2 human approvals on abc1234');
});

test('dist has no imports beyond node builtins', () => {
  const src = readFileSync(join(root, 'dist/review-policy.mjs'), 'utf8');
  for (const m of src.matchAll(/^import .* from '([^']+)';$/gm)) assert.match(m[1], /^node:/);
});

test('running dist without an environment exits 1 with an error', () => {
  assert.throws(
    () => execFileSync(process.execPath, [join(root, 'dist/review-policy.mjs')], { env: { PATH: process.env.PATH }, stdio: 'pipe' }),
    (e) => e.status === 1 && /GITHUB_REPOSITORY is not set/.test(e.stderr.toString()),
  );
});
