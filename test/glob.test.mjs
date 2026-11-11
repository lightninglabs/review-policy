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
  // Git allows newlines and line separators in file names; a trailing
  // "**" must still match them.
  ['sqldb/**', 'sqldb/m\n.go', true],
  ['sqldb/**', 'sqldb/m\r.go', true],
  ['sqldb/**', 'sqldb/m\u2028.go', true],
  ['sqldb/**', 'sqldb/m\u2029.go', true],
  ['.github/**', '.github/workflows/x\n.yml', true],
  ['**', 'a\n/b', true],
  ['*', 'm\n.go', true],
  ['file?.txt', 'file\n.txt', true],
];
for (const [pat, path, want] of cases) {
  test(`${pat} ${want ? 'matches' : 'does not match'} ${path}`, () => assert.equal(matchGlob(pat, path), want));
}
