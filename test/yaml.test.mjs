import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseYaml } from '../src/yaml.mjs';
import { README_CONFIG } from './fixtures.mjs';

test('parses the README example', () => {
  const y = parseYaml(README_CONFIG);
  assert.equal(y.version, 1);
  assert.deepEqual(y.bots, ['lightninglabs-gateway[bot]']);
  assert.deepEqual(y.floor.high, ['htlcswitch/**', 'routing/**', 'peer/**']);
  assert.deepEqual(y.never_auto_approve.slice(-2), ['**/AGENTS.md', '**/CLAUDE.md']);
  assert.deepEqual(y.tiers.high, { humans: 1, fresh: true });
  assert.deepEqual(y.tiers.low, { humans: 0, bot: true });
  assert.deepEqual(y.experts, { alice: ['htlcswitch/**', 'routing/**'] });
});

test('scalars', () => {
  assert.deepEqual(parseYaml('a: 1\nb: -2\nc: true\nd: false\ne: null\nf: ~\ng:\nh: yes\ni: 1.5\nj: "x # y"\nk: \'it\'\'s\'\nl: a b # c'), {
    a: 1, b: -2, c: true, d: false, e: null, f: null, g: null, h: 'yes', i: '1.5', j: 'x # y', k: "it's", l: 'a b',
  });
});

test('sequence at the same indent as its key', () => {
  assert.deepEqual(parseYaml('a:\n- x\n- "y"\nb: 1'), { a: ['x', 'y'], b: 1 });
});

test('multi-line flow collections and trailing commas', () => {
  assert.deepEqual(parseYaml('a: [\n  "x",  # one\n  y,\n]\nb: { c: 1,\n d: [e] }'), { a: ['x', 'y'], b: { c: 1, d: ['e'] } });
});

test('leading document marker is allowed', () => {
  assert.deepEqual(parseYaml('---\na: 1'), { a: 1 });
});

test('empty document is null', () => {
  assert.equal(parseYaml('# nothing\n'), null);
});

for (const [name, src, re] of [
  ['tabs', 'a:\n\t- x', /tabs/],
  ['alias', 'a: *x', /unsupported/],
  ['anchor', 'a: &x 1', /unsupported/],
  ['tag', 'a: !!str 1', /unsupported/],
  ['block scalar', 'a: |\n  x', /unsupported/],
  ['unquoted glob starting with *', 'a: [**/x]', /unsupported/],
  ['duplicate key', 'a: 1\na: 2', /duplicate key/],
  ['duplicate flow key', 'a: {b: 1, b: 2}', /duplicate key/],
  ['bad indentation', 'a:\n  b: 1\n   c: 2', /indentation/],
  ['mapping in a sequence', 'a:\n  - b: 1', /not supported/],
  ['multiple documents', 'a: 1\n---\nb: 2', /multiple documents/],
  ['unterminated flow', 'a: [x, y', /unterminated/],
  ['unterminated quote', 'a: "x', /unterminated/],
  ['trailing junk', 'a: [x] y', /trailing/],
  ['colon in plain value', 'a: b: c', /quote the value/],
  ['brackets in a flow plain scalar', 'a: [x[bot], y]', /expected/],
  ['not a mapping line', 'just text', /expected "key: value"/],
]) {
  test(`rejects ${name}`, () => assert.throws(() => parseYaml(src), re));
}

test('__proto__ key does not pollute', () => {
  const y = parseYaml('__proto__: 1\nb: {__proto__: 2}');
  assert.equal(Object.getPrototypeOf(y), Object.prototype);
  assert.equal(Object.hasOwn(y, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
