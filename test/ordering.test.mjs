/**
 * Ordering is observable, and it is pinned behaviourally.
 *
 * A source scan for `.localeCompare(` is not a determinism test: substituting
 * `Intl.Collator` produces identical collation drift with different source
 * text. These inputs are chosen because code-unit order and collation order
 * genuinely disagree about them, and the test asserts the emitted order.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit } from '../src/index.mjs'
import { columnNamed, csvText, profileText, runCli, withTempDir, writeText } from './helpers.mjs'

// `Z` (0x5A) precedes `a` (0x61) by code unit and follows it by collation;
// `-` (0x2D) precedes `_` (0x5F) by code unit and is ignorable punctuation to a
// collator. Both disagreements were measured in this catalog.
const NAMES = ['alpha', 'assets', 'a_b', 'a-b', 'Zulu', 'README']

test('columns and findings come out in UTF-16 code-unit order', async () => {
  const rows = [NAMES.map(() => ''), NAMES.map(() => '')]
  const report = await profileText(csvText(NAMES, rows))
  const names = report.columns.map((column) => column.name)
  assert.deepEqual(names, ['README', 'Zulu', 'a-b', 'a_b', 'alpha', 'assets'])
  assert.deepEqual(
    report.findings.map((finding) => finding.location.pointer),
    [
      '/columns/README', '/columns/README',
      '/columns/Zulu', '/columns/Zulu',
      '/columns/a-b', '/columns/a-b',
      '/columns/a_b', '/columns/a_b',
      '/columns/alpha', '/columns/alpha',
      '/columns/assets', '/columns/assets',
    ],
  )

  // Without this the test would pass under a collator too, and an assertion
  // that cannot fail is not a test.
  const collated = [...names].sort((a, b) => new Intl.Collator('en').compare(a, b))
  assert.notDeepEqual(collated, names)
})

test('two findings about one column sort by rule id', async () => {
  const report = await profileText(csvText(['id', 'note'], [['R-1', ''], ['R-2', '']]))
  const forNote = report.findings
    .filter((finding) => finding.location.pointer === '/columns/note')
    .map((finding) => finding.ruleId)
  assert.deepEqual(forNote, ['column-not-evaluable', 'missingness-above-threshold'])
})

test('outlier examples are ordered strongest first, and ties break by row', async () => {
  const values = [50, 51, 49, 52, 48, 50, 53, 47, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49]
  values[2] = 300
  values[9] = -300
  values[15] = 300
  const report = await profileText(
    csvText(['id', 'reading'], values.map((value, index) => [`S-${index + 1}`, value])),
  )
  const examples = columnNamed(report, 'reading').numeric.examples
  assert.equal(examples.length, 3)
  // -300 is furthest from the median of about 50, then the two 300s in row
  // order: an equal score must not swap places between runs.
  assert.deepEqual(examples.map((example) => example.row), [11, 4, 17])
  assert.equal(examples[0].value, -300)
  assert.equal(examples[1].value, 300)
  assert.equal(examples[2].value, 300)
})

test('unexpected categories are named in code-unit order', async () => {
  const values = ['zulu', 'Alpha', 'a_b', 'a-b', 'north']
  const report = await profileText(
    csvText(['id', 'region'], values.map((value, index) => [`R-${index + 1}`, value])),
    { baseline: { columns: { id: {}, region: { allowed: ['north'] } } } },
  )
  assert.deepEqual(
    columnNamed(report, 'region').categories.unexpected.map((entry) => entry.value),
    ['Alpha', 'a-b', 'a_b', 'zulu'],
  )
})

test('byCodeUnit is a total order over the cases collation disagrees about', () => {
  assert.equal(byCodeUnit('Z', 'a') < 0, true)
  assert.equal(byCodeUnit('a-b', 'a_b') < 0, true)
  assert.equal(byCodeUnit('README', 'assets') < 0, true)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('running the CLI twice over one file produces byte-identical stdout', async () => {
  await withTempDir(async (directory) => {
    const path = await writeText(
      directory,
      'data.csv',
      csvText(NAMES, [NAMES.map((_, index) => index), NAMES.map((_, index) => index * 2)]),
    )
    const first = await runCli(['--csv', path, '--json'])
    const second = await runCli(['--csv', path, '--json'])
    assert.equal(first.stdout, second.stdout)
    assert.equal(first.code, second.code)
    assert.ok(first.stdout.length > 500)
  })
})
