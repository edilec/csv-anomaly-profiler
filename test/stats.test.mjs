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
  ROUNDING_CEILING,
  num,
  asNumber,
  median,
  medianAbsoluteDeviation,
  modifiedZScore,
  quantile,
  sortedCopy,
} from '../src/index.mjs'
import { columnNamed, csvText, profileText } from './helpers.mjs'

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

test('rounding a report number never turns something into nothing', async () => {
  // A dispersion of 0.0000003 printed as 0 would sit beside a verdict computed
  // from a dispersion that is NOT zero, and the two would disagree about the
  // same thing. A value too small to survive the rounding is printed as it is.
  assert.equal(num(0.0000003), 0.0000003)
  assert.equal(num(-0.0000003), -0.0000003)
  assert.equal(num(0), 0)
  assert.equal(num(-0), 0)
  assert.equal(num(1.23456789), 1.234568)
  assert.equal(num(Infinity), null)

  // And end to end: thirteen values spaced a ten-millionth apart have a real,
  // tiny dispersion, so the column gets a real verdict and a dispersion the
  // report does not flatten to zero.
  const values = Array.from({ length: 13 }, (_, index) => 1 + (index + 1) / 10000000)
  const report = await profileText(
    csvText(['id', 'reading'], values.map((value, index) => [`S-${index}`, value])),
  )
  const reading = columnNamed(report, 'reading')
  assert.equal(reading.numeric.verdict, 'evaluated')
  assert.ok(reading.numeric.dispersion > 0)
  assert.equal(reading.numeric.outlierCount, 0)
  assert.equal(report.status, 'pass')
})

test('rounding a report number never turns a number into nothing at the other end either', () => {
  // The same rule as above, arriving from the other direction: the finite check
  // asks about the INPUT and the rounding multiplies by a million, so a value
  // over about 1.8e302 came back as Infinity -- which JSON writes as null.
  assert.equal(num(1e307), 1e307)
  assert.equal(num(-1e307), -1e307)
  assert.equal(num(1.8e302), 1.8e302)
  assert.equal(num(Number.MAX_VALUE), Number.MAX_VALUE)
  assert.equal(Number.isFinite(num(1e307)), true)

  // Both sides of the bound. At the ceiling the value is still rounded; one
  // step past it the value is returned as it is, and either way it is a number.
  assert.equal(num(ROUNDING_CEILING), Math.round(ROUNDING_CEILING * 1000000) / 1000000)
  assert.equal(num(ROUNDING_CEILING * 2), ROUNDING_CEILING * 2)
  assert.equal(num(ROUNDING_CEILING + 0.00000004), ROUNDING_CEILING)
})

test('a very large value reaches the report as a number, not as null beside the word Infinity', async () => {
  const values = Array.from({ length: 20 }, (_, index) => 50 + (index % 3))
  const report = await profileText(
    csvText(['id', 'reading'], [...values, 1e307].map((value, index) => [`S-${index}`, value])),
  )
  const reading = columnNamed(report, 'reading')
  assert.equal(reading.numeric.outlierCount, 1)
  assert.equal(reading.numeric.examples[0].value, 1e307)
  assert.ok(Number.isFinite(reading.numeric.examples[0].score))

  const [finding] = report.findings.filter((entry) => entry.ruleId === 'numeric-outlier')
  assert.ok(finding.message.includes('holds 1e+307'))
  assert.equal(finding.message.includes('Infinity'), false)
  // Not only the fields this test names: no number in the example arrives as
  // null. `reason` and `fences` are null because there is nothing to report in
  // them, which is a different thing.
  assert.equal(JSON.stringify(reading.numeric.examples).includes('null'), false)
  assert.ok(Number.isFinite(reading.numeric.median))
  assert.ok(Number.isFinite(reading.numeric.dispersion))
  assert.equal(report.status, 'fail')
})
