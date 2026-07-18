const { test } = require('node:test');
const assert = require('node:assert');
const { parseSeedIds } = require('../systems/whitelist.js');

test('parseSeedIds: splits on commas and whitespace, trims, dedupes', () => {
  assert.deepStrictEqual(parseSeedIds('123456789012345, 234567890123456 123456789012345'), [
    '123456789012345',
    '234567890123456',
  ]);
});

test('parseSeedIds: drops non-snowflake garbage', () => {
  assert.deepStrictEqual(parseSeedIds('abc, 12, 123456789012345678, <id>'), ['123456789012345678']);
});

test('parseSeedIds: empty/undefined input gives empty array', () => {
  assert.deepStrictEqual(parseSeedIds(''), []);
  assert.deepStrictEqual(parseSeedIds(undefined), []);
});
