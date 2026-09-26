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

import { CATALOG } from '../src/index.mjs'
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

  // And it says HOW MUCH evidence it did not get. `charlie` and `delta` were
  // dropped by the cap, so a count of zero here would be a sentence
  // contradicting itself: no value was dropped, and the index is truncated.
  assert.equal(region.categories.notIndexed, 2)
  assert.ok(withheld[0].message.startsWith('2 value or values in region were not added'))
})

test('the count of dropped evidence is the count, not the counters that were convenient', async () => {
  // 31 distinct values against a cap of 4: 27 values were dropped, and the
  // count in the message is the one a reader would arrive at by hand.
  const values = Array.from({ length: 31 }, (_, index) => `v${String(index).padStart(2, '0')}`)
  const report = await profileText(regions(values), {
    config: { limits: { maxDistinctCategories: 4 } },
    baseline: { columns: { id: {}, region: { allowed: values.slice(0, 4) } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.categories.truncated, true)
  assert.equal(region.categories.distinct, 4)
  assert.equal(region.categories.notIndexed, 27)
  const withheld = findingsFor(report, 'category-comparison-incomplete')
  assert.ok(withheld[0].message.startsWith('27 value or values in region were not added'))
  assert.equal(report.status, 'incomplete')
})

test('a value too long for the index and a value dropped by the cap are both counted', async () => {
  // Two different reasons evidence was lost, in one column: the count is their
  // sum, and neither is left out because the other was easier to reach.
  const report = await profileText(regions(['alpha', 'bravo', 'x'.repeat(9), 'charlie']), {
    config: { limits: { maxDistinctCategories: 2, maxCategoryLength: 8 } },
    baseline: { columns: { id: {}, region: { allowed: ['alpha', 'bravo'] } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.values.categoryOversized, 1)
  assert.equal(region.categories.truncated, true)
  assert.equal(region.categories.notIndexed, 2)
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
  // The companion the absence needs: an assertion that pins what IS there. The
  // baseline entry declares `categories`, so blaming the baseline for this gap
  // would send a consumer to correct the document that was not at fault.
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.reason, 'observed-index-incomplete')
  assert.ok(ruleIds(report).includes('drift-undetermined'))
  assert.ok(ruleIds(report).includes('value-unprintable'))
  assert.equal(report.status, 'incomplete')
})

test('every drift reason names the document or the evidence that was actually missing', async () => {
  const declared = { categories: { north: 0.5, south: 0.5 } }
  const clean = regions(['north', 'south'])
  const seen = new Set()

  const cases = [
    // no baseline at all
    [clean, null, 'no-baseline'],
    // a baseline that says nothing about this column
    [clean, { columns: { id: {} } }, 'no-baseline-entry'],
    // an entry that exists and declares neither comparison
    [clean, { columns: { id: {}, region: {} } }, 'baseline-entry-declares-nothing'],
    // an entry that declares a rate over a file with no value to compare
    ['id,region\n', { columns: { id: {}, region: { missingRate: 0.1 } } }, 'no-values-observed'],
    // an entry that declares a distribution over a column of nothing but
    // missing values: the index is whole and holds no value to compare
    [regions(['', '']), { columns: { id: {}, region: { categories: { north: 1 } } } }, 'no-values-observed'],
    // an entry that declares a distribution the observed index cannot answer
    [regions(['north', `south${CONTROL}`]), { columns: { id: {}, region: declared } }, 'observed-index-incomplete'],
    // an entry that declares a rate over a file whose rows were not all read
    [regions(['north', 'south', 'north']), { columns: { id: {}, region: { missingRate: 0.5 } } },
      'file-not-profiled-in-full', { limits: { maxRows: 2 } }],
  ]

  for (const [document, baseline, expected, config = null] of cases) {
    const report = await profileText(document, { baseline, config })
    const region = columnNamed(report, 'region')
    assert.equal(region.drift.compared, false, expected)
    assert.equal(region.drift.reason, expected, expected)
    seen.add(expected)
  }

  // Every documented reason is reachable, and no reason is documented that
  // nothing produces.
  assert.deepEqual([...seen].sort(), [...CATALOG.driftReasons].sort())

  // And an entry that declares TWO comparisons where only one can be made is
  // compared, not withheld: the reason exists for the case where nothing came
  // out at all.
  const partly = await profileText(regions(['north', `south${CONTROL}`]), {
    baseline: {
      columns: { id: {}, region: { missingRate: 0, categories: { north: 0.5, south: 0.5 } } },
    },
  })
  const region = columnNamed(partly, 'region')
  assert.equal(region.drift.compared, true)
  assert.equal(region.drift.reason, null)
  assert.equal(region.drift.missingRate.observed, 0)
  assert.equal(region.drift.categories, null)
})

test('a comparison is reported as made only when a number came out of it', async () => {
  // The index is whole and empty: every value in the column is missing. A
  // comparison "made" with a null distance beside it is the same invention as
  // one computed from a gap, arriving through the other door.
  const report = await profileText(regions(['', '']), {
    baseline: { columns: { id: {}, region: { categories: { north: 1 } } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.categories.indexComplete, true)
  assert.equal(region.categories.distinct, 0)
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.categories, null)
  assert.ok(findingsFor(report, 'drift-undetermined')[0].message.includes('observed no value in the column'))
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

const STEADY = Array.from({ length: 24 }, (_, index) => 50 + (index % 3))

function readings(values) {
  return csvText(['id', 'reading'], values.map((value, index) => [`S-${index + 1}`, value]))
}

test('a verdict over part of a column is not a verdict about the column', async () => {
  // Twenty of a hundred rows read, and the planted value sits in the part that
  // was never read. The fence is real and so is every value outside it, but the
  // ABSENCE of one establishes nothing -- and `verdict` is the field a consumer
  // reads to ask whether the column was evaluated.
  const values = [...STEADY, ...STEADY, 9999]
  const report = await profileText(readings(values), { config: { limits: { maxRows: 24 } } })
  const reading = columnNamed(report, 'reading')

  assert.equal(reading.numeric.verdict, 'partial')
  assert.equal(reading.numeric.reason, 'evidence-incomplete')
  assert.equal(reading.numeric.examined, 24)
  assert.equal(reading.numeric.outlierCount, 0)
  assert.equal(reading.evidence.rowsComplete, false)
  assert.equal(reading.evidence.valuesComplete, false)
  assert.equal(report.summary.columnsEvaluated, 0)
  assert.equal(report.summary.columnsPartial, 1)
  assert.equal(report.summary.columnsUndetermined, 0)
  assert.ok(ruleIds(report).includes('row-limit-exceeded'))
  assert.equal(report.status, 'incomplete')
})

test('a partial verdict still reports every value it DID see outside the fence', async () => {
  // The positive half stands, exactly as it does for a truncated category
  // index: a value this run saw outside a fence it computed is not in doubt.
  const values = [...STEADY, 9999, ...STEADY]
  const report = await profileText(readings(values), { config: { limits: { maxRows: 25 } } })
  const reading = columnNamed(report, 'reading')
  assert.equal(reading.numeric.verdict, 'partial')
  assert.equal(reading.numeric.outlierCount, 1)
  assert.equal(reading.numeric.examples[0].value, 9999)
  assert.equal(report.summary.outliers, 1)
  assert.equal(findingsFor(report, 'numeric-outlier').length, 1)
  // Incomplete outranks fail: the run did not establish what the file holds.
  assert.equal(report.status, 'incomplete')
})

test('a partial verdict can never appear in a green run', async () => {
  // Every reason a verdict is partial -- a row past the limit, a malformed row,
  // a ragged row, an unterminated quote, a value too long, a value that does
  // not print -- also raises a finding in the unsettled set. The invariant is
  // what keeps `partial` from becoming a quiet second kind of pass.
  const cases = [
    [readings([...STEADY, ...STEADY]), { limits: { maxRows: 24 } }],
    [`${readings(STEADY)}S-25,"unclosed\n`, null],
    [`${readings(STEADY)}S-25,50,extra\n`, null],
    [`${readings(STEADY)}S-25,"5"0\n`, null],
    [readings([...STEADY.slice(0, 23), '123456789']), { limits: { maxFieldLength: 8 } }],
    [readings([...STEADY.slice(0, 23), `4${CONTROL}2`]), null],
  ]
  for (const [document, config] of cases) {
    const report = await profileText(document, { config })
    const reading = columnNamed(report, 'reading')
    assert.notEqual(reading.numeric.verdict, 'evaluated', document.slice(-24))
    assert.equal(report.status, 'incomplete', document.slice(-24))
  }
})

test('a rate compared from part of a file is not compared at all', async () => {
  // The sharpest form of the invention: the file's real missing rate IS the
  // baseline's, and a drift computed from the first twenty rows reported a
  // change of 0.8 at error severity -- a claim about a file this run never read.
  const values = Array.from({ length: 100 }, (_, index) => (index < 20 ? 'north' : ''))
  const report = await profileText(regions(values), {
    config: { limits: { maxRows: 20 } },
    baseline: { columns: { id: {}, region: { missingRate: 0.8 } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.missingRate, 0)
  assert.equal(findingsFor(report, 'missingness-drift').length, 0)
  assert.equal(findingsFor(report, 'missingness-above-threshold').length, 0)
  assert.equal(region.drift.compared, false)
  assert.equal(region.drift.missingRate, null)
  assert.equal(region.drift.reason, 'file-not-profiled-in-full')
  assert.ok(findingsFor(report, 'drift-undetermined')[0].message.includes('did not profile every row'))
  assert.equal(report.status, 'incomplete')
})

test('a missingness threshold is not judged from the rows that happened to be read', async () => {
  // The first ten rows are empty and the other ninety are not: the file's rate
  // is 0.1 and the prefix's is 1. Judging the threshold from the prefix reports
  // a column as mostly missing when it is mostly present.
  const values = Array.from({ length: 100 }, (_, index) => (index < 10 ? '' : 'north'))
  const partial = await profileText(regions(values), { config: { limits: { maxRows: 10 } } })
  const region = columnNamed(partial, 'region')
  assert.equal(region.missingRate, 1)
  assert.equal(region.evidence.missingRateExact, false)
  assert.equal(findingsFor(partial, 'missingness-above-threshold').length, 0)
  assert.equal(partial.status, 'incomplete')

  // Read in full the same file is under the threshold, and a file that really
  // is over it is still reported: the gate withholds a verdict, it does not
  // disable the check.
  const full = await profileText(regions(values))
  assert.equal(full.missingRate, undefined)
  assert.equal(columnNamed(full, 'region').missingRate, 0.1)
  assert.equal(findingsFor(full, 'missingness-above-threshold').length, 0)
  assert.equal(full.status, 'pass')

  const over = await profileText(regions(values.map((value, index) => (index < 30 ? '' : value))))
  assert.equal(findingsFor(over, 'missingness-above-threshold').length, 1)
  assert.equal(over.status, 'fail')
})

test('a distribution is not compared from the rows that happened to be read', async () => {
  // The index holds every value it was OFFERED and still does not hold every
  // value the column contains, because the reader stopped at row twenty.
  const values = Array.from({ length: 100 }, (_, index) => (index < 50 ? 'north' : 'south'))
  const baseline = { columns: { id: {}, region: { categories: { north: 0.5, south: 0.5 } } } }
  const partial = await profileText(regions(values), { config: { limits: { maxRows: 20 } }, baseline })
  const region = columnNamed(partial, 'region')
  assert.equal(region.categories.indexComplete, false)
  assert.equal(region.drift.categories, null)
  assert.equal(region.drift.reason, 'file-not-profiled-in-full')
  assert.equal(findingsFor(partial, 'category-drift').length, 0)
  assert.ok(findingsFor(partial, 'drift-undetermined')[0].message.includes('did not profile every row'))
  assert.equal(partial.status, 'incomplete')

  // Read in full, the distribution IS the baseline's and the distance is 0.
  const full = await profileText(regions(values), { baseline })
  assert.equal(columnNamed(full, 'region').categories.indexComplete, true)
  assert.equal(columnNamed(full, 'region').drift.categories.distance, 0)
  assert.equal(full.status, 'pass')
})

test('the same file read in full does compare the rate, so the refusal above is not blanket', async () => {
  const values = Array.from({ length: 100 }, (_, index) => (index < 20 ? 'north' : ''))
  const report = await profileText(regions(values), {
    baseline: { columns: { id: {}, region: { missingRate: 0.8 } } },
  })
  const region = columnNamed(report, 'region')
  assert.equal(region.evidence.missingRateExact, true)
  assert.equal(region.missingRate, 0.8)
  assert.equal(region.drift.compared, true)
  assert.equal(region.drift.missingRate.delta, 0)
  assert.equal(findingsFor(report, 'missingness-drift').length, 0)
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
