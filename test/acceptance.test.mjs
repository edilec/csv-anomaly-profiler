/**
 * The acceptance criteria, item by item.
 *
 *   "A known outlier is detected under the selected method; mixed types and
 *    small samples are handled without unsupported conclusions."
 *
 * The first half is easy to satisfy and easy to satisfy badly, so the good case
 * comes first: a column with no planted value must produce no finding at all.
 * The second half is the one that decides whether this tool is worth reading:
 * a column that cannot support a verdict has to say so, and saying so has to
 * change the exit code.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { columnNamed, csvText, findingsFor, profileText, ruleIds, runCli, withTempDir, writeText } from './helpers.mjs'

const STEADY = [50, 51, 49, 52, 48, 50, 53, 47, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49]

function readings(values) {
  return csvText(['sample_id', 'reading'], values.map((value, index) => [`S-${index + 1}`, value]))
}

test('the good case first: a steady column produces no finding at all', async () => {
  const report = await profileText(readings(STEADY))
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  const reading = columnNamed(report, 'reading')
  assert.equal(reading.type, 'numeric')
  assert.equal(reading.numeric.verdict, 'evaluated')
  assert.equal(reading.numeric.outlierCount, 0)
  assert.equal(reading.values.examined, 20)
})

test('a known outlier is detected under the mad method, with the row and the value', async () => {
  const values = [...STEADY]
  values[13] = 500
  const report = await profileText(readings(values), { method: 'mad' })
  const reading = columnNamed(report, 'reading')

  assert.equal(reading.numeric.method, 'mad')
  assert.equal(reading.numeric.verdict, 'evaluated')
  assert.equal(reading.numeric.outlierCount, 1)
  // Row 15 of the file: the header is line 1, so the fourteenth data row is
  // line 15, which is what a person opening the file would count to.
  assert.deepEqual(reading.numeric.examples, [
    { row: 15, value: 500, score: reading.numeric.examples[0].score },
  ])
  assert.ok(reading.numeric.examples[0].score > 3.5)
  assert.equal(reading.numeric.median, 50)

  const found = findingsFor(report, 'numeric-outlier')
  assert.equal(found.length, 1)
  assert.equal(found[0].severity, 'error')
  assert.ok(found[0].message.includes('Row 15 of reading holds 500'))
  assert.equal(report.status, 'fail')
  assert.equal(report.summary.outliers, 1)
})

test('the same outlier is detected under the iqr method, which is a different fence', async () => {
  const values = [...STEADY]
  values[13] = 500
  const report = await profileText(readings(values), { method: 'iqr' })
  const reading = columnNamed(report, 'reading')

  assert.equal(reading.numeric.method, 'iqr')
  assert.equal(reading.numeric.outlierCount, 1)
  assert.equal(reading.numeric.examples[0].row, 15)
  assert.equal(reading.numeric.examples[0].value, 500)
  // The two methods do not agree by construction: this one reports a fence and
  // the other a modified z-score, and the report says which produced it.
  assert.equal(reading.numeric.constant, null)
  assert.ok(reading.numeric.fences.high < 500)
  assert.equal(report.status, 'fail')

  // The finding says what this method measured, and does not quote a threshold
  // that multiplies the interquartile range beside a score that counts
  // interquartile ranges past the fence: those are two different quantities.
  const message = findingsFor(report, 'numeric-outlier')[0].message
  assert.ok(message.includes('outside the interquartile fence of'))
  assert.ok(message.includes('interquartile range or ranges'))
  assert.equal(message.includes('modified z-score'), false)

  const byMad = await profileText(readings(values), { method: 'mad' })
  const madMessage = findingsFor(byMad, 'numeric-outlier')[0].message
  assert.ok(madMessage.includes('whose modified z-score against the column median is'))
  assert.ok(madMessage.includes('past the configured 3.5'))
  assert.equal(madMessage.includes('interquartile'), false)
})

test('the method actually changes the verdict, so "the selected method" means something', async () => {
  // Nineteen values at 10 and one at 13. The interquartile range is zero, so
  // the iqr method has no fence to place and refuses; the median absolute
  // deviation is also zero, so mad refuses too -- and a method that quietly
  // returned "no outliers" here would be dividing by zero and calling the
  // result evidence.
  const flat = Array.from({ length: 19 }, () => 10)
  const values = [...flat, 13]
  for (const method of ['mad', 'iqr']) {
    const report = await profileText(readings(values), { method })
    const reading = columnNamed(report, 'reading')
    assert.equal(reading.numeric.verdict, 'undetermined', method)
    assert.equal(reading.numeric.reason, 'dispersion-degenerate', method)
    assert.equal(reading.numeric.dispersion, 0, method)
    assert.equal(findingsFor(report, 'numeric-outlier').length, 0, method)
    assert.ok(ruleIds(report).includes('dispersion-degenerate'), method)
    assert.equal(report.status, 'incomplete', method)
  }

  // A spread column, on the other hand, is where the two fences genuinely
  // disagree. Fifteen values from 10 to 24 and one at 36: the interquartile
  // range is 7.5 and the fence ends at 32.5, so iqr reports it; the median
  // absolute deviation is 4, which puts 36 at a modified z-score of 3.12, under
  // the 3.5 threshold, so mad does not. Neither is wrong, and which one ran is
  // in the report.
  const spread = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 36]
  const byMad = columnNamed(await profileText(readings(spread), { method: 'mad' }), 'reading')
  const byIqr = columnNamed(await profileText(readings(spread), { method: 'iqr' }), 'reading')
  assert.equal(byMad.numeric.outlierCount, 0)
  assert.equal(byMad.numeric.dispersion, 4)
  // 0.6745 * (36 - 17.5) / 4 = 3.119875, which the README quotes as 3.12. The
  // number is pinned here so the documented example cannot drift from the code.
  assert.equal(byMad.numeric.median, 17.5)
  assert.equal(Math.round(0.6745 * (36 - 17.5) / 4 * 100) / 100, 3.12)
  assert.equal(byIqr.numeric.outlierCount, 1)
  assert.equal(byIqr.numeric.dispersion, 7.5)
  assert.equal(byIqr.numeric.examples[0].value, 36)
  assert.equal(byIqr.numeric.fences.high, 32.5)
})

test('a small sample gets no verdict, says why, and does not exit 0', async () => {
  const values = [4.2, 4.4, 4.1, 4.5, 4.3, 4.6]
  const report = await profileText(readings(values))
  const reading = columnNamed(report, 'reading')

  assert.equal(reading.type, 'numeric')
  assert.equal(reading.numeric.verdict, 'undetermined')
  assert.equal(reading.numeric.reason, 'sample-too-small')
  assert.equal(reading.numeric.examined, 6)
  assert.equal(reading.numeric.minSample, 12)
  // No outlier finding, and no statement that there are none.
  assert.equal(findingsFor(report, 'numeric-outlier').length, 0)
  assert.equal(reading.numeric.outlierCount, undefined)
  assert.deepEqual(ruleIds(report), ['sample-too-small'])
  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'incomplete')
})

test('a mixed column gets no numeric verdict, because a fence from its numeric half describes nothing', async () => {
  const values = [...STEADY]
  const rows = values.map((value, index) => [`S-${index + 1}`, value])
  rows[4][1] = 'pending'
  rows[9][1] = 'n/k'
  const report = await profileText(csvText(['sample_id', 'reading'], rows))
  const reading = columnNamed(report, 'reading')

  assert.equal(reading.type, 'mixed')
  assert.equal(reading.values.numeric, 18)
  assert.equal(reading.values.other, 2)
  assert.equal(reading.numeric.verdict, 'undetermined')
  assert.equal(reading.numeric.reason, 'mixed-types')
  assert.equal(reading.numeric.median, undefined)
  assert.equal(findingsFor(report, 'numeric-outlier').length, 0)
  assert.deepEqual(ruleIds(report), ['column-mixed-types'])
  assert.equal(report.status, 'incomplete')
})

test('a mixed column hides an outlier rather than reporting one from half a column', async () => {
  // The planted value is still there. Reporting it would mean computing a
  // median over the rows that happen to parse, which describes a column that
  // does not exist -- so this run says what it could not do instead.
  const rows = STEADY.map((value, index) => [`S-${index + 1}`, value])
  rows[13][1] = 500
  rows[4][1] = 'pending'
  const report = await profileText(csvText(['sample_id', 'reading'], rows))
  assert.equal(columnNamed(report, 'reading').numeric.reason, 'mixed-types')
  assert.equal(findingsFor(report, 'numeric-outlier').length, 0)
  assert.equal(report.status, 'incomplete')
  assert.ok(
    report.findings[0].message.includes('would describe a column that does not exist'),
  )
})

test('the refusals reach the command line as exit 2, not as a quiet exit 0', async () => {
  await withTempDir(async (directory) => {
    const small = await writeText(directory, 'small.csv', readings([1, 2, 3, 4, 5, 6]))
    const smallRun = await runCli(['--csv', small, '--json'])
    assert.equal(smallRun.code, 2)
    assert.equal(JSON.parse(smallRun.stdout).status, 'incomplete')

    const rows = STEADY.map((value, index) => [`S-${index + 1}`, value])
    rows[2][1] = 'unknown'
    const mixed = await writeText(directory, 'mixed.csv', csvText(['sample_id', 'reading'], rows))
    const mixedRun = await runCli(['--csv', mixed, '--json'])
    assert.equal(mixedRun.code, 2)
    assert.equal(JSON.parse(mixedRun.stdout).status, 'incomplete')

    const planted = [...STEADY]
    planted[13] = 500
    const outlier = await writeText(directory, 'outlier.csv', readings(planted))
    const outlierRun = await runCli(['--csv', outlier, '--json'])
    assert.equal(outlierRun.code, 1)
    assert.equal(JSON.parse(outlierRun.stdout).status, 'fail')
  })
})
