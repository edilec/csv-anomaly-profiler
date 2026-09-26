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
  assert.equal(region.values.reshaped, 4)
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
  assert.equal(region.values.reshaped, 1)
  assert.equal(report.status, 'pass')
})

test('a quoted field carrying a line break is examined, because that is what quoting is for', async () => {
  // RFC 4180 section 2.6: a field containing a line break is enclosed in double
  // quotes. It is the one thing quoting exists for, so an export with
  // multi-line notes must not be permanently incomplete.
  const report = await profileText('id,note\nR-1,"line1\nline2"\nR-2,plain\n')
  const note = columnNamed(report, 'note')
  assert.equal(note.values.unprintable, 0)
  assert.equal(note.values.examined, 2)
  assert.equal(note.values.reshaped, 1)
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
  // The line break itself never reaches the output: it is printed collapsed.
  assert.equal(JSON.stringify(report).includes('line1\\nline2'), false)
})

test('the multi-line export exits 0 at the command line, and a hidden character still does not', async () => {
  await withTempDir(async (directory) => {
    const good = await writeText(directory, 'notes.csv', 'id,note\nR-1,"line1\nline2"\nR-2,plain\n')
    const goodRun = await runCli(['--csv', good, '--json'])
    assert.equal(goodRun.code, 0)
    assert.equal(JSON.parse(goodRun.stdout).status, 'pass')

    // The negative twin: a bidi override is not layout. It reverses displayed
    // text, so the value still does not print as it is stored.
    const hidden = await writeText(
      directory,
      'hidden.csv',
      `id,note\nR-1,line1${String.fromCharCode(0x202e)}line2\nR-2,plain\n`,
    )
    const hiddenRun = await runCli(['--csv', hidden, '--json'])
    assert.equal(hiddenRun.code, 2)
    const report = JSON.parse(hiddenRun.stdout)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((finding) => finding.ruleId === 'value-unprintable'))
  })
})

test('a tab inside a field is layout, and a tabbed value matches its baseline entry', async () => {
  const report = await profileText(regions(['north\twest', 'north west']), {
    baseline: { columns: { id: {}, region: { allowed: ['north west'] } } },
  })
  const region = columnNamed(report, 'region')
  assert.deepEqual(region.categories.top, [{ value: 'north west', count: 2 }])
  assert.equal(region.values.unprintable, 0)
  assert.equal(report.status, 'pass')
})

const PAIRS = Array.from({ length: 20 }, (_, index) => [String(index + 1), String((index + 1) * 2)])

function pairs(extra) {
  return `a,b\n${PAIRS.map((row) => row.join(',')).join('\n')}\n${extra}`
}

test('a blank line between data rows is not a row that fails to match the header', async () => {
  // Every reader of this format skips a blank line. Reporting it as a ragged
  // row at error severity sent somebody to correct a file with nothing wrong
  // with it -- and a trailing blank line is what a text editor leaves behind.
  const report = await profileText(pairs('\n3,6\n'))
  assert.equal(findingsFor(report, 'row-field-count-mismatch').length, 0)
  assert.deepEqual(ruleIds(report), ['blank-line-skipped'])
  assert.equal(report.findings[0].severity, 'info')
  assert.equal(report.summary.rowsBlank, 1)
  assert.equal(report.summary.rowsSkipped, 0)
  assert.equal(report.summary.rowsProfiled, 21)
  assert.equal(report.status, 'pass')

  // Skipped is not the same as passed over in silence: the line is named.
  assert.ok(report.findings[0].message.includes('first at line 22'))
})

test('the blank line exits 0 at the command line, and a ragged row still does not', async () => {
  await withTempDir(async (directory) => {
    const good = await writeText(directory, 'blank.csv', pairs('\n3,6\n'))
    const goodRun = await runCli(['--csv', good, '--json'])
    assert.equal(goodRun.code, 0)
    assert.equal(JSON.parse(goodRun.stdout).status, 'pass')

    // The negative twin: a row that really does not match the header is not
    // forgiven, because which value belongs to which column is not established.
    const ragged = await writeText(directory, 'ragged.csv', pairs('3,6,9\n'))
    const raggedRun = await runCli(['--csv', ragged, '--json'])
    assert.equal(raggedRun.code, 2)
    const report = JSON.parse(raggedRun.stdout)
    assert.ok(report.findings.some((finding) => finding.ruleId === 'row-field-count-mismatch'))
    assert.equal(report.status, 'incomplete')
  })
})

test('a blank line is a value, not a blank line, when the header declares one column', async () => {
  // With one column the file cannot mean anything else: the line IS a row whose
  // single value is empty, and skipping it would drop a row that was there.
  const report = await profileText('a\n1\n\n3\n')
  assert.equal(report.summary.rowsBlank, 0)
  assert.equal(report.summary.rowsProfiled, 3)
  assert.equal(columnNamed(report, 'a').values.total, 3)
  assert.equal(columnNamed(report, 'a').values.missing, 1)
  assert.equal(ruleIds(report).includes('blank-line-skipped'), false)
})

test('a quoted empty field on its own line is a row with one field, not a blank line', async () => {
  // `""` is a row whose single value is the empty string. A reader that could
  // not tell it from a blank line would silently drop it, so the difference is
  // carried out of the reader rather than guessed at afterwards.
  const report = await profileText(pairs('""\n'))
  assert.equal(report.summary.rowsBlank, 0)
  assert.equal(findingsFor(report, 'row-field-count-mismatch').length, 1)
  assert.equal(report.status, 'incomplete')
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
