import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatChange } from './usage-format.ts';

test('small changes keep one decimal at most', () => {
  assert.equal(formatChange(4.25), '+4.3%');
  assert.equal(formatChange(4), '+4%');
  assert.equal(formatChange(-0.5), '−0.5%');
  assert.equal(formatChange(0), '0%');
  assert.equal(formatChange(0.01), '0%');
});

test('from ten percent up to 999 the change is a whole number', () => {
  assert.equal(formatChange(12.5), '+13%');
  assert.equal(formatChange(9.96), '+10%');
  assert.equal(formatChange(-42.4), '−42%');
  assert.equal(formatChange(-100), '−100%');
  assert.equal(formatChange(383.2), '+383%');
  assert.equal(formatChange(999.4), '+999%');
});

test('a thousand percent and more reads as a multiplier', () => {
  assert.equal(formatChange(999.5), '×11');
  assert.equal(formatChange(1000), '×11');
  assert.equal(formatChange(1380.1), '×15');
  assert.equal(formatChange(16408), '×165');
});

test('nothing to compare gives nothing', () => {
  assert.equal(formatChange(undefined), '');
  assert.equal(formatChange(Number.NaN), '');
  assert.equal(formatChange(Number.POSITIVE_INFINITY), '');
});
