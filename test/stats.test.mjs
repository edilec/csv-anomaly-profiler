/**
 * The order statistics, pinned against worked values.
 *
 * The quantile definition is named in the source and it has to be the one the
 * source names: different definitions put a fence in a different place, and a
 * reader comparing this output with another tool needs the numbers to be
 * re-derivable. These are the values R's type 7 and NumPy's `linear` produce.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAD_CONSTANT,
  asNumber,
  median,
  medianAbsoluteDeviation,
  modifiedZScore,
  quantile,
  sortedCopy,
} from '../src/index.mjs'

test('the median of an odd and an even count', () => {
  assert.equal(median([1, 2, 3]), 2)
  assert.equal(median([1, 2, 3, 4]), 2.5)
  assert.equal(median([7]), 7)
  assert.equal(median([]), null)
})

test('the quantile is linear interpolation between the closest ranks', () => {
  const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  assert.equal(quantile(values, 0.25), 3.25)
  assert.equal(quantile(values, 0.5), 5.5)
  assert.equal(quantile(values, 0.75), 7.75)
  assert.equal(quantile(values, 0), 1)
  assert.equal(quantile(values, 1), 10)
  assert.equal(quantile([5], 0.25), 5)
  assert.equal(quantile([], 0.5), null)
})

test('the median absolute deviation, and the constant beside it', () => {
  const values = sortedCopy([1, 2, 3, 4, 100])
  assert.equal(median(values), 3)
  assert.equal(medianAbsoluteDeviation(values, 3), 1)
  assert.equal(MAD_CONSTANT, 0.6745)
  assert.equal(modifiedZScore(100, 3, 1), 0.6745 * 97)
  assert.equal(modifiedZScore(3, 3, 1), 0)
  assert.equal(modifiedZScore(1, 3, 1), -0.6745 * 2)
})

test('sorting is numeric, not textual', () => {
  // `[10, 9].sort()` is `[10, 9]` with the default comparator, which would put
  // the median of a numeric column in the wrong place.
  assert.deepEqual(sortedCopy([10, 9, 100, 2]), [2, 9, 10, 100])
  assert.equal(median(sortedCopy([10, 9, 100, 2])), 9.5)
})

test('what counts as a number, and what does not', () => {
  for (const [text, expected] of [
    ['12', 12], ['-3.5', -3.5], ['+4', 4], ['.5', 0.5], ['1e3', 1000], ['  7  ', 7], ['0012', 12],
  ]) {
    assert.equal(asNumber(text), expected, text)
  }
  for (const text of ['', 'NaN', 'Infinity', '1,234', '12px', '1 2', '--3', '0x10', 'null']) {
    assert.equal(asNumber(text), null, text)
  }
})

test('a zero deviation is reported as zero rather than turned into a score', () => {
  const flat = sortedCopy([5, 5, 5, 5, 5])
  assert.equal(medianAbsoluteDeviation(flat, 5), 0)
  assert.equal(quantile(flat, 0.75) - quantile(flat, 0.25), 0)
  // The caller must check first: this is what the check exists to avoid.
  assert.equal(modifiedZScore(9, 5, 0), Infinity)
})
