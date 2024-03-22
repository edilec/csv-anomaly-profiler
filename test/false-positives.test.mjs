/**
 * The good case, constructed by somebody who knows what good looks like.
 *
 * A finding raised on correct input is the worst defect a checker can have. A
 * miss leaves the reader where they were; a false positive sends them to fix
 * something that was already right, and after the second time nobody reads the
 * output again. So each test here drives a file that is NOT wrong through the
 * real entry point and asserts what the run says about it -- including the exit
 * code, because "no error finding" and "exit 0" are two different claims.
 *
 * Each also carries its negative twin in the same test: the shape that really
 * is wrong still has to be reported, or the guard is just a blanket.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  columnNamed,
  csvText,
  findingsFor,
  profileText,
  ruleIds,
  runCli,
  withTempDir,
  writeJson,
  writeText,
} from './helpers.mjs'

function regions(values) {
  return csvText(['id', 'region'], values.map((value, index) => [`R-${index + 1}`, value]))
}

/** `id, region` with `R-1, north`: an ordinary export, padded by the exporter. */
const PADDED = 'id, region\nR-1, north\nR-2, south\nR-3, north\nR-4, south\n'

const MATCHING_BASELINE = {
  schemaVersion: '1',
  columns: {
    id: {},
    region: { allowed: ['north', 'south'], categories: { north: 0.5, south: 0.5 } },
  },
}

test('a padded export against a matching baseline reports nothing about its data', async () => {
  const report = await profileText(PADDED, {
    baseline: { columns: MATCHING_BASELINE.columns },
  })
  const region = columnNamed(report, 'region')

  // The distribution IS the baseline's, so there is nothing to say about it.
  assert.deepEqual(findingsFor(report, 'unexpected-category'), [])
  assert.equal(region.drift.categories.distance, 0)
  assert.equal(findingsFor(report, 'category-drift').length, 0)

  // The index and the message agree about what the values are, because they are
  // the same strings: a comparison made on ` north` and printed as `north` is
  // how a report comes to contradict itself.
  assert.deepEqual(region.categories.top, [
    { value: 'north', count: 2 },
    { value: 'south', count: 2 },
  ])

  // The whitespace difference is real and is reported -- as the difference it
  // is, at info, which leaves the status to the other findings.
  assert.deepEqual(ruleIds(report), ['category-whitespace-collapsed'])
  assert.equal(report.findings[0].severity, 'info')
  assert.equal(region.categories.reshaped, 4)
  assert.ok(report.findings[0].message.includes('not a different value'))
  assert.equal(report.status, 'pass')
})

test('the padded export exits 0 at the command line, where the exit code cannot be edited', async () => {
  await withTempDir(async (directory) => {
    const csv = await writeText(directory, 'padded.csv', PADDED)
    const baseline = await writeJson(directory, 'baseline.json', MATCHING_BASELINE)
    const result = await runCli(['--csv', csv, '--baseline', baseline, '--json'])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).status, 'pass')
  })
})

test('a value the baseline really does not list is still named, and named as it prints', async () => {
  const report = await profileText('id, region\nR-1, north\nR-2, west\n', {
    baseline: { columns: { id: {}, region: { allowed: ['north', 'south'] } } },
  })
  const region = columnNamed(report, 'region')

  // Not a blanket: `west` is absent from the baseline and is reported.
  assert.deepEqual(region.categories.unexpected, [{ value: 'west', count: 1 }])
  const named = findingsFor(report, 'unexpected-category')
  assert.equal(named.length, 1)
  assert.equal(named[0].severity, 'error')
  // The value the message prints is the value the comparison used, character
  // for character. This is the assertion the padded case failed.
  assert.ok(named[0].message.includes(`holds the value ${region.categories.unexpected[0].value} in 1 row`))
  assert.equal(report.status, 'fail')
})

test('an internal run of whitespace is a whitespace difference, not a different value', async () => {
  const report = await profileText(regions(['north  west', 'north west']), {
    baseline: { columns: { id: {}, region: { allowed: ['north west'] } } },
  })
  const region = columnNamed(report, 'region')
  assert.deepEqual(region.categories.top, [{ value: 'north west', count: 2 }])
  assert.deepEqual(findingsFor(report, 'unexpected-category'), [])
  assert.equal(region.categories.reshaped, 1)
  assert.equal(report.status, 'pass')
})

test('a baseline value that does not print as it is written is refused when the document is read', async () => {
  await withTempDir(async (directory) => {
    const csv = await writeText(directory, 'padded.csv', PADDED)
    const baseline = await writeJson(directory, 'baseline.json', {
      schemaVersion: '1',
      columns: { id: {}, region: { allowed: [' north', 'south'] } },
    })
    const result = await runCli(['--csv', csv, '--baseline', baseline, '--json'])
    // A configuration error: the run never had a subject, so stdout stays empty.
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.ok(result.stderr.includes('must print exactly as it is written'))
  })
})

test('a value that prints as nothing at all is not examined and not indexed', async () => {
  const report = await profileText(regions(['north', '   ', 'north']), {
    baseline: { columns: { id: {}, region: { allowed: ['north'] } } },
  })
  const region = columnNamed(report, 'region')
  // It is a value, so it is not missing; it cannot be named, so no claim about
  // it is made and the index that dropped it is not called complete.
  assert.equal(region.values.missing, 0)
  assert.equal(region.values.unprintable, 1)
  assert.equal(region.values.examined, 2)
  assert.deepEqual(region.categories.top, [{ value: 'north', count: 2 }])
  assert.equal(region.categories.indexComplete, false)
  assert.ok(ruleIds(report).includes('value-unprintable'))
  assert.equal(report.status, 'incomplete')
})
