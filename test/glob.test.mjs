import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchGlob } from '../src/glob.mjs';

const cases = [
  ['sqldb/**', 'sqldb/a.go', true],
  ['sqldb/**', 'sqldb/x/y/z.sql', true],
  ['sqldb/**', 'sqldbx/a.go', false],
  ['sqldb/**', 'x/sqldb/a.go', false],
  ['channeldb/migration*/**', 'channeldb/migration33/m.go', true],
  ['channeldb/migration*/**', 'channeldb/migration/m.go', true],
  ['channeldb/migration*/**', 'channeldb/migration_01_to_11/a/b.go', true],
  ['channeldb/migration*/**', 'channeldb/graph.go', false],
  ['**/AGENTS.md', 'AGENTS.md', true],
  ['**/AGENTS.md', 'a/b/AGENTS.md', true],
  ['**/AGENTS.md', 'a/NOTAGENTS.md', false],
  ['go.mod', 'go.mod', true],
  ['go.mod', 'tools/go.mod', false],
  ['go.mod', 'goxmod', false],
  ['.github/**', '.github/workflows/a.yml', true],
  ['a/**/b.go', 'a/b.go', true],
  ['a/**/b.go', 'a/x/y/b.go', true],
  ['*.go', 'main.go', true],
  ['*.go', 'cmd/main.go', false],
  ['file?.txt', 'file1.txt', true],
  ['file?.txt', 'file/.txt', false],
  ['a+b/(c)', 'a+b/(c)', true],
  ['**', 'anything/at/all', true],
];
for (const [pat, path, want] of cases) {
  test(`${pat} ${want ? 'matches' : 'does not match'} ${path}`, () => assert.equal(matchGlob(pat, path), want));
}
