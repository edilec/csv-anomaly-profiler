/**
 * Unknown is never a pass -- on both sides of the comparison.
 *
 * The sharpest violation of this rule found in the catalog: a tool dropped the
 * values it could not evaluate out of the index it compares against, then
 * asserted POSITIVELY that a literal matched nothing in the group, and exited
 * 0. The two halves of that are separable, and the tests below separate them.
 *
 * A value this run SAW and the baseline does not list is not in doubt, whatever
 * else was dropped, so the finding about it stands. Whether the column holds
 * OTHER values the baseline does not list is exactly what a truncated index
 * cannot say, so that claim is withheld and the run is incomplete.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { columnNamed, csvText, findingsFor, profileText, ruleIds, runCli, withTempDir, writeText } from './helpers.mjs'

const CONTROL = String.fromCharCode(0x01)
const BIDI = String.fromCharCode(0x202e)

function regions(values) {
  return csvText(['id', 'region'], values.map((value, index) => [`R-${index + 1}`, value]))
}

test('with no baseline, this tool makes no category or drift claim at all', async () => {
  const report = await profileText(regions(['north', 'south', 'north', 'south']))
  const region = columnNamed(report, 'region')
  assert.equal(region.categories.tracked, false)
  assert.equal(region.categories.reason, 'no-baseline')
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.reason, 'no-baseline')
  assert.equal(region.drift.categories, null)
  // Not "no drift" and not "nothing unexpected": no answer, because no evidence
  // was given for the question.
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a column the baseline says nothing about is a gap, and the gap changes the exit code', async () => {
  const report = await profileText(regions(['north', 'south']), {
    baseline: { columns: { id: { missingRate: 0 } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.reason, 'no-baseline-entry')
  assert.deepEqual(ruleIds(report), ['baseline-entry-missing'])
  assert.ok(report.findings[0].message.includes('not a comparison that passed'))
  assert.equal(report.summary.errors, 0)
  assert.equal(report.status, 'incomplete')
})

test('a baseline entry that declares nothing compares nothing, and says so', async () => {
  // An entry exists, so there is no gap to report -- and nothing in it was
  // compared, so the column entry must not read as a comparison that passed.
  const report = await profileText(regions(['north', 'south']), {
    baseline: { columns: { id: {}, region: {} } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.reason, 'baseline-entry-declares-nothing')
  assert.equal(region.categories.tracked, false)
  assert.equal(region.categories.reason, 'baseline-declares-no-categories')
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a baseline entry that declares one comparison reports that one as compared', async () => {
  const report = await profileText(regions(['north', 'south']), {
    baseline: { columns: { id: {}, region: { missingRate: 0 } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.drift.compared, true)
  assert.equal(region.drift.reason, null)
  assert.equal(region.drift.missingRate.delta, 0)
  assert.equal(region.drift.categories, null)
})

test('a baseline column the file does not have is reported, not skipped', async () => {
  const report = await profileText(regions(['north', 'south']), {
    baseline: { columns: { id: {}, region: {}, gone: { missingRate: 0.1 } } },
  })
  assert.deepEqual(ruleIds(report), ['baseline-column-absent'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.status, 'incomplete')
})

test('a truncated index keeps its positive findings and loses its negative claim', async () => {
  const report = await profileText(
    regions(['alpha', 'bravo', 'charlie', 'delta', 'alpha']),
    {
      config: { limits: { maxDistinctCategories: 2 } },
      baseline: { columns: { id: {}, region: { allowed: ['alpha'] } } },
    },
  )
  const region = columnNamed(report, 'region')

  // The index held the first two distinct values and refused the rest.
  assert.equal(region.categories.tracked, true)
  assert.equal(region.categories.indexComplete, false)
  assert.equal(region.categories.truncated, true)
  assert.equal(region.categories.distinct, 2)

  // POSITIVE: bravo was seen and the baseline does not list it. That stands.
  assert.deepEqual(findingsFor(report, 'unexpected-category').map((finding) => finding.message), [
    'region holds the value bravo in 1 row or rows, and the baseline does not list it.',
  ])

  // NEGATIVE: whether the column holds others is exactly what this index cannot
  // say, and the run does not exit 0 pretending otherwise.
  const withheld = findingsFor(report, 'category-comparison-incomplete')
  assert.equal(withheld.length, 1)
  assert.ok(withheld[0].message.includes('whether the column holds others'))
  assert.ok(ruleIds(report).includes('categories-truncated'))
  assert.equal(report.status, 'incomplete')
})

test('a value that cannot be indexed withholds the drift number rather than computing one from a gap', async () => {
  const report = await profileText(
    regions(['north', 'south', `north${CONTROL}`, 'south']),
    {
      baseline: {
        columns: { id: {}, region: { categories: { north: 0.5, south: 0.5 } } },
      },
    },
  )
  const region = columnNamed(report, 'region')
  assert.equal(region.values.unprintable, 1)
  assert.equal(region.categories.indexComplete, false)
  // No distance at all: a distance computed against an index that dropped a
  // value is a number with no meaning, and printing one would be the invention.
  assert.equal(region.drift.categories, null)
  assert.ok(ruleIds(report).includes('drift-undetermined'))
  assert.ok(ruleIds(report).includes('value-unprintable'))
  assert.equal(report.status, 'incomplete')
})

test('a complete index does get its drift number, so the refusal above is not blanket', () => {
  return profileText(regions(['north', 'south', 'north', 'south']), {
    baseline: { columns: { id: {}, region: { categories: { north: 0.5, south: 0.5 } } } },
  }).then((report) => {
    const region = columnNamed(report, 'region')
    assert.equal(region.categories.indexComplete, true)
    assert.equal(region.drift.categories.distance, 0)
    assert.equal(ruleIds(report).includes('drift-undetermined'), false)
    assert.equal(report.status, 'pass')
  })
})

test('a row that does not match the header is not attributed to any column', async () => {
  const text = 'id,region,units\nR-1,north,10\nR-2,north\nR-3,south,12\n'
  const report = await profileText(text)
  assert.equal(report.summary.rows, 3)
  assert.equal(report.summary.rowsProfiled, 2)
  assert.equal(report.summary.rowsSkipped, 1)
  // Two rows, not three: the short row's values were not spread across the
  // columns on a guess about which one was missing.
  assert.equal(columnNamed(report, 'region').values.total, 2)
  assert.ok(ruleIds(report).includes('row-field-count-mismatch'))
  assert.equal(report.status, 'incomplete')
})

test('a malformed row is refused and named, and the rest of the file is still profiled', async () => {
  const text = 'id,note\nR-1,plain\nR-2,"ab"c\nR-3,plain\n'
  const report = await profileText(text)
  assert.equal(report.summary.rowsProfiled, 2)
  assert.ok(ruleIds(report).includes('row-malformed'))
  assert.ok(report.findings.some((finding) => finding.message.includes('first at line 3')))
  assert.equal(report.status, 'incomplete')
})

test('a file with a header and no data rows establishes nothing, and says so', async () => {
  const report = await profileText('id,region\n')
  assert.deepEqual(ruleIds(report), ['no-rows-profiled'])
  assert.equal(report.summary.rowsProfiled, 0)
  assert.equal(report.status, 'incomplete')
})

test('a column with rows but nothing examined gets no verdict, and says which rows went where', async () => {
  const report = await profileText(csvText(['id', 'note'], [['R-1', ''], ['R-2', ''], ['R-3', '']]))
  const note = columnNamed(report, 'note')
  assert.equal(note.type, 'undetermined')
  assert.equal(note.values.total, 3)
  assert.equal(note.values.missing, 3)
  assert.equal(note.values.examined, 0)
  assert.equal(note.numeric.reason, 'no-values-examined')
  assert.ok(ruleIds(report).includes('column-not-evaluable'))
  // Missingness is still counted exactly, and it is still above the default.
  assert.equal(note.missingRate, 1)
  assert.ok(ruleIds(report).includes('missingness-above-threshold'))
  assert.equal(report.status, 'incomplete')
})

test('a value longer than the field bound is counted out of the totals rather than trimmed into them', async () => {
  const text = csvText(['id', 'note'], [['R-1', 'short'], ['R-2', 'x'.repeat(40)]])
  const report = await profileText(text, { config: { limits: { maxFieldLength: 16 } } })
  const note = columnNamed(report, 'note')
  assert.equal(note.values.total, 2)
  assert.equal(note.values.examined, 1)
  assert.equal(note.values.oversized, 1)
  assert.deepEqual(ruleIds(report), ['field-too-long'])
  assert.equal(report.status, 'incomplete')
})

test('a run whose only finding is a warning still exits 2, because the question stayed open', async () => {
  await withTempDir(async (directory) => {
    const path = await writeText(
      directory,
      'data.csv',
      csvText(['id', 'reading'], [['R-1', 5], ['R-2', 6], ['R-3', 7]]),
    )
    const result = await runCli(['--csv', path, '--json'])
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['sample-too-small'])
    assert.equal(report.summary.errors, 0)
    assert.equal(report.summary.warnings, 1)
    // Membership of the unsettled set is the ONLY thing between this warning
    // and exit 0, which is why the exit code is asserted rather than the
    // membership.
    assert.equal(report.status, 'incomplete')
    assert.equal(result.code, 2)
  })
})

test('a header that cannot be an identity stops the run instead of profiling the wrong columns', async () => {
  const duplicate = await profileText('id,id\n1,2\n')
  assert.deepEqual(ruleIds(duplicate), ['duplicate-column'])
  assert.deepEqual(duplicate.columns, [])
  assert.equal(duplicate.status, 'incomplete')

  const forged = await profileText(`id,a${BIDI}b\n1,2\n`)
  assert.deepEqual(ruleIds(forged), ['header-column-unusable'])
  assert.deepEqual(forged.columns, [])
  assert.equal(forged.status, 'incomplete')
})

test('the report names what this kind of evidence never settles', async () => {
  const report = await profileText(regions(['north']))
  assert.ok(report.disclaimer.includes('not a judgement about the value'))
  assert.equal(report.notEstablished.length, 4)
  assert.ok(report.notEstablished.some((line) => line.includes('free of outliers')))
})
