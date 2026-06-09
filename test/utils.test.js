const { test } = require('node:test');
const assert = require('node:assert');
const { chunk, isoDurationToSeconds } = require('../systems/alerts/utils.js');

test('chunk splits an array into fixed-size groups', () => {
  assert.deepStrictEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('chunk returns [] for empty input', () => {
  assert.deepStrictEqual(chunk([], 100), []);
});

test('chunk keeps everything in one group when size >= length', () => {
  assert.deepStrictEqual(chunk([1, 2], 100), [[1, 2]]);
});

test('isoDurationToSeconds regression: 3-minute Short parses to 180', () => {
  assert.strictEqual(isoDurationToSeconds('PT3M'), 180);
  assert.strictEqual(isoDurationToSeconds('PT1M5S'), 65);
  assert.strictEqual(isoDurationToSeconds('garbage'), null);
});
