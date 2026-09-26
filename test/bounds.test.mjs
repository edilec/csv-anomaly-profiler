/**
 * Every declared limit, from BOTH sides.
 *
 * A bound has two sides and most suites only test one. "Fires at N+1" and
 * "stays silent at exactly N" are two assertions, and the second is the one
 * users notice: widening a comparison by one starts refusing files that sit
 * exactly on a limit the documentation calls legal, with the whole suite green.
 */

import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import test from 'node:test'

import {
  ConfigError,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_BASELINE_BYTES,
  MAX_CATEGORY_CHARACTERS,
  MAX_CELLS,
  MAX_CONFIG_BYTES,
  MAX_MISSING_TOKENS,
  MAX_TOP_CATEGORIES,
  NUMBER_RANGES,
  validateConfig,
} from '../src/index.mjs'
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

const STEADY = [50, 51, 49, 52, 48, 50, 53, 47, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49]

function readings(values) {
  return csvText(['sample_id', 'reading'], values.map((value, index) => [`S-${index + 1}`, value]))
}

function categorical(values) {
  return csvText(['id', 'region'], values.map((value, index) => [`R-${index + 1}`, value]))
}

test('maxRows: exactly the limit is profiled, one more is reported as unread', async () => {
  const rows = ['a', 'b', 'c', 'd']
  const atLimit = await profileText(categorical(rows.slice(0, 3)), { config: { limits: { maxRows: 3 } } })
  assert.equal(atLimit.summary.rowsProfiled, 3)
  assert.equal(ruleIds(atLimit).includes('row-limit-exceeded'), false)

  const overLimit = await profileText(categorical(rows), { config: { limits: { maxRows: 3 } } })
  assert.equal(overLimit.summary.rowsProfiled, 3)
  assert.ok(ruleIds(overLimit).includes('row-limit-exceeded'))
  assert.equal(overLimit.status, 'incomplete')
})

test('maxColumns: exactly the limit is profiled, one more stops the run', async () => {
  const atLimit = await profileText('a,b,c\n1,2,3\n', { config: { limits: { maxColumns: 3 } } })
  assert.equal(atLimit.summary.columns, 3)
  assert.equal(ruleIds(atLimit).includes('column-limit-exceeded'), false)

  const overLimit = await profileText('a,b,c,d\n1,2,3,4\n', { config: { limits: { maxColumns: 3 } } })
  assert.deepEqual(ruleIds(overLimit), ['column-limit-exceeded'])
  assert.deepEqual(overLimit.columns, [])
  assert.equal(overLimit.status, 'incomplete')
})

test('maxFieldLength: a value of exactly the limit is examined, one longer is not', async () => {
  const eight = 'x'.repeat(8)
  const atLimit = await profileText(
    csvText(['id', 'note'], [['R-1', eight]]),
    { config: { limits: { maxFieldLength: 8 } } },
  )
  assert.equal(columnNamed(atLimit, 'note').values.examined, 1)
  assert.equal(ruleIds(atLimit).includes('field-too-long'), false)

  const overLimit = await profileText(
    csvText(['id', 'note'], [['R-1', `${eight}x`]]),
    { config: { limits: { maxFieldLength: 8 } } },
  )
  assert.equal(columnNamed(overLimit, 'note').values.oversized, 1)
  assert.ok(ruleIds(overLimit).includes('field-too-long'))
})

test('maxDistinctCategories: exactly the limit is indexed, one more truncates the index', async () => {
  const baseline = { columns: { id: {}, region: { allowed: ['a', 'b', 'c'] } } }
  const atLimit = await profileText(categorical(['a', 'b', 'c']), {
    config: { limits: { maxDistinctCategories: 3 } },
    baseline,
  })
  assert.equal(columnNamed(atLimit, 'region').categories.distinct, 3)
  assert.equal(columnNamed(atLimit, 'region').categories.indexComplete, true)
  assert.equal(ruleIds(atLimit).includes('categories-truncated'), false)

  const overLimit = await profileText(categorical(['a', 'b', 'c', 'd']), {
    config: { limits: { maxDistinctCategories: 3 } },
    baseline,
  })
  assert.equal(columnNamed(overLimit, 'region').categories.distinct, 3)
  assert.equal(columnNamed(overLimit, 'region').categories.indexComplete, false)
  assert.ok(ruleIds(overLimit).includes('categories-truncated'))
})

test('maxCategoryLength: a value of exactly the limit is indexed, one longer is not', async () => {
  const eight = 'y'.repeat(8)
  const baseline = { columns: { id: {}, region: { allowed: [eight] } } }
  const atLimit = await profileText(categorical([eight]), {
    config: { limits: { maxCategoryLength: 8 } },
    baseline,
  })
  assert.equal(columnNamed(atLimit, 'region').values.categoryOversized, 0)
  assert.equal(columnNamed(atLimit, 'region').categories.indexComplete, true)

  const overLimit = await profileText(categorical([`${eight}y`]), {
    config: { limits: { maxCategoryLength: 8 } },
    baseline,
  })
  assert.equal(columnNamed(overLimit, 'region').values.categoryOversized, 1)
  assert.equal(columnNamed(overLimit, 'region').categories.indexComplete, false)
  assert.ok(ruleIds(overLimit).includes('category-comparison-incomplete'))
})

test('maxBytes: a file of exactly the limit is read, one byte more is refused', async () => {
  await withTempDir(async (directory) => {
    const path = await writeText(directory, 'data.csv', categorical(['a', 'b']))
    const size = (await stat(path)).size

    const atLimit = await runCli([
      '--csv', path, '--json',
      '--config', await writeJson(directory, 'at.json', { schemaVersion: '1', limits: { maxBytes: size } }),
    ])
    assert.equal(JSON.parse(atLimit.stdout).findings.some((finding) => finding.ruleId === 'csv-too-large'), false)

    const overLimit = await runCli([
      '--csv', path, '--json',
      '--config', await writeJson(directory, 'over.json', { schemaVersion: '1', limits: { maxBytes: size - 1 } }),
    ])
    assert.equal(overLimit.code, 2)
    assert.deepEqual(JSON.parse(overLimit.stdout).findings.map((finding) => finding.ruleId), ['csv-too-large'])
  })
})

test('the configuration and the baseline each have their own byte bound, from both sides', async () => {
  await withTempDir(async (directory) => {
    const csv = await writeText(directory, 'data.csv', categorical(['a', 'b']))
    const pad = (body, size) => body + ' '.repeat(size - body.length)

    const configBody = '{"schemaVersion":"1"}'
    const configAt = await writeText(directory, 'at.json', pad(configBody, MAX_CONFIG_BYTES))
    const configOver = await writeText(directory, 'over.json', pad(configBody, MAX_CONFIG_BYTES + 1))
    assert.equal((await stat(configAt)).size, MAX_CONFIG_BYTES)
    assert.equal((await runCli(['--csv', csv, '--config', configAt, '--json'])).stdout === '', false)
    const configRefused = await runCli(['--csv', csv, '--config', configOver, '--json'])
    assert.equal(configRefused.code, 2)
    assert.equal(configRefused.stdout, '')
    assert.ok(configRefused.stderr.includes(`exceeds the ${MAX_CONFIG_BYTES} byte limit`))

    const baselineBody = '{"schemaVersion":"1","columns":{"id":{},"region":{}}}'
    const baselineAt = await writeText(directory, 'b-at.json', pad(baselineBody, MAX_BASELINE_BYTES))
    const baselineOver = await writeText(directory, 'b-over.json', pad(baselineBody, MAX_BASELINE_BYTES + 1))
    assert.equal((await runCli(['--csv', csv, '--baseline', baselineAt, '--json'])).stdout === '', false)
    const baselineRefused = await runCli(['--csv', csv, '--baseline', baselineOver, '--json'])
    assert.equal(baselineRefused.code, 2)
    assert.equal(baselineRefused.stdout, '')
    assert.ok(baselineRefused.stderr.includes(`exceeds the ${MAX_BASELINE_BYTES} byte limit`))
  })
})

/**
 * Companions hold the OTHER factors of a product bound small enough that only
 * the limit under test can fire, so a ceiling assertion is never satisfied by a
 * product refusal.
 */
const COMPANIONS = Object.freeze({
  maxRows: { maxColumns: 10 },
  maxColumns: { maxRows: 1953, maxDistinctCategories: 256, maxCategoryLength: 64 },
  maxDistinctCategories: { maxColumns: 1 },
  maxCategoryLength: { maxColumns: 1 },
})

test('every configurable limit accepts 1 and its ceiling, and refuses 0 and one past the ceiling', () => {
  // Enumerated from LIMIT_NAMES rather than listed by hand, so a limit added
  // later is covered without anybody remembering to add it here.
  assert.deepEqual([...LIMIT_NAMES].sort(), [
    'maxBytes', 'maxCategoryLength', 'maxColumns', 'maxDistinctCategories', 'maxFieldLength', 'maxRows',
  ])
  for (const name of LIMIT_NAMES) {
    const build = (value) => validateConfig({
      schemaVersion: '1',
      limits: { ...(COMPANIONS[name] ?? {}), [name]: value },
    })
    assert.equal(build(1).limits[name], 1, `${name} must accept 1`)
    assert.equal(build(LIMIT_CEILINGS[name]).limits[name], LIMIT_CEILINGS[name], `${name} must accept its ceiling`)
    assert.throws(() => build(0), ConfigError, `${name} must refuse 0`)
    assert.throws(() => build(LIMIT_CEILINGS[name] + 1), ConfigError, `${name} must refuse one past its ceiling`)
    assert.throws(() => build(1.5), ConfigError, `${name} must refuse a fraction`)
  }
})

test('the two product bounds hold at exactly the cap and refuse one past it', () => {
  const wide = { maxColumns: 1000, maxDistinctCategories: 256, maxCategoryLength: 128 }
  const cells = validateConfig({ schemaVersion: '1', limits: { ...wide, maxRows: 2000 } })
  assert.equal(cells.limits.maxRows * cells.limits.maxColumns, MAX_CELLS)
  assert.throws(
    () => validateConfig({ schemaVersion: '1', limits: { ...wide, maxRows: 2001 } }),
    (error) => error instanceof ConfigError && error.message.includes('values one run may retain'),
  )

  const characters = validateConfig({
    schemaVersion: '1',
    limits: { maxRows: 1000, maxColumns: 1024, maxDistinctCategories: 256, maxCategoryLength: 128 },
  })
  const { maxColumns, maxDistinctCategories, maxCategoryLength } = characters.limits
  assert.equal(maxColumns * maxDistinctCategories * maxCategoryLength, MAX_CATEGORY_CHARACTERS)
  assert.throws(
    () => validateConfig({
      schemaVersion: '1',
      limits: { maxRows: 1000, maxColumns: 1024, maxDistinctCategories: 256, maxCategoryLength: 129 },
    }),
    (error) => error instanceof ConfigError && error.message.includes('characters one run may retain'),
  )
})

test('every configurable number accepts its ends and refuses just outside them', () => {
  for (const [name, range] of Object.entries(NUMBER_RANGES)) {
    const build = (value) => validateConfig({ schemaVersion: '1', [name]: value })
    const step = range.integer ? 1 : 0.0001
    if (range.exclusiveMin) {
      assert.throws(() => build(range.min), ConfigError, `${name} must refuse its exclusive minimum`)
      assert.equal(build(range.min + step)[name], range.min + step, `${name} must accept just above it`)
    } else {
      assert.equal(build(range.min)[name], range.min, `${name} must accept its minimum`)
      assert.throws(() => build(range.min - step), ConfigError, `${name} must refuse just below it`)
    }
    assert.equal(build(range.max)[name], range.max, `${name} must accept its maximum`)
    assert.throws(() => build(range.max + step), ConfigError, `${name} must refuse just above it`)
    if (range.integer) assert.throws(() => build(range.min + 0.5), ConfigError, `${name} must refuse a fraction`)
  }
})

test('the missing-token list is bounded, at exactly the cap and one past it', () => {
  const tokens = Array.from({ length: MAX_MISSING_TOKENS }, (_, index) => `NA-${index}`)
  assert.equal(validateConfig({ schemaVersion: '1', missingTokens: tokens }).missingTokens.length, MAX_MISSING_TOKENS)
  assert.throws(
    () => validateConfig({ schemaVersion: '1', missingTokens: [...tokens, 'one-more'] }),
    ConfigError,
  )
})

test('minSample: exactly the sample gives a verdict, one fewer refuses one', async () => {
  const atLimit = await profileText(readings(STEADY.slice(0, 12)))
  assert.equal(columnNamed(atLimit, 'reading').numeric.verdict, 'evaluated')
  assert.equal(ruleIds(atLimit).includes('sample-too-small'), false)

  const below = await profileText(readings(STEADY.slice(0, 11)))
  assert.equal(columnNamed(below, 'reading').numeric.verdict, 'undetermined')
  assert.ok(ruleIds(below).includes('sample-too-small'))
})

test('outlierThreshold: a score exactly at the threshold is inside the fence, just under it is outside', async () => {
  const values = [...STEADY]
  values[13] = 90
  const measured = columnNamed(await profileText(readings(values)), 'reading').numeric.examples[0].score

  const atThreshold = await profileText(readings(values), { config: { outlierThreshold: measured } })
  assert.equal(columnNamed(atThreshold, 'reading').numeric.outlierCount, 0)

  const justUnder = await profileText(readings(values), { config: { outlierThreshold: measured - 0.0001 } })
  assert.equal(columnNamed(justUnder, 'reading').numeric.outlierCount, 1)
})

test('maxMissingRate: a rate exactly at the threshold passes, just above it fails', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => [`R-${index + 1}`, index < 2 ? '' : 'north'])
  const text = csvText(['id', 'region'], rows)
  const atThreshold = await profileText(text, { config: { maxMissingRate: 0.2 } })
  assert.equal(columnNamed(atThreshold, 'region').missingRate, 0.2)
  assert.equal(ruleIds(atThreshold).includes('missingness-above-threshold'), false)

  const justBelow = await profileText(text, { config: { maxMissingRate: 0.19 } })
  assert.ok(ruleIds(justBelow).includes('missingness-above-threshold'))
})

test('maxMissingRateDrift and maxCategoryDrift each hold at exactly the threshold', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => [`R-${index + 1}`, index < 2 ? '' : 'north'])
  const text = csvText(['id', 'region'], rows)
  const baseline = { columns: { id: {}, region: { missingRate: 0.1, categories: { north: 1 } } } }

  const atThreshold = await profileText(text, {
    config: { maxMissingRate: 1, maxMissingRateDrift: 0.1 },
    baseline,
  })
  assert.equal(columnNamed(atThreshold, 'region').drift.missingRate.delta, 0.1)
  assert.equal(ruleIds(atThreshold).includes('missingness-drift'), false)

  const justBelow = await profileText(text, {
    config: { maxMissingRate: 1, maxMissingRateDrift: 0.0999 },
    baseline,
  })
  assert.ok(ruleIds(justBelow).includes('missingness-drift'))

  const drifted = { columns: { id: {}, region: { categories: { north: 0.75, south: 0.25 } } } }
  const distance = columnNamed(
    await profileText(text, { config: { maxMissingRate: 1, maxCategoryDrift: 1 }, baseline: drifted }),
    'region',
  ).drift.categories.distance
  assert.equal(distance, 0.25)
  const at = await profileText(text, { config: { maxMissingRate: 1, maxCategoryDrift: distance }, baseline: drifted })
  assert.equal(ruleIds(at).includes('category-drift'), false)
  const under = await profileText(text, {
    config: { maxMissingRate: 1, maxCategoryDrift: distance - 0.0001 },
    baseline: drifted,
  })
  assert.ok(ruleIds(under).includes('category-drift'))
})

test('maxExamples: exactly that many are listed without a note, one more adds one', async () => {
  const values = [...STEADY]
  values[3] = 400
  values[7] = 500
  values[13] = 600
  const atLimit = await profileText(readings(values), { config: { maxExamples: 3 } })
  assert.equal(columnNamed(atLimit, 'reading').numeric.outlierCount, 3)
  assert.equal(columnNamed(atLimit, 'reading').numeric.examples.length, 3)
  assert.equal(findingsFor(atLimit, 'examples-limited').length, 0)

  const overLimit = await profileText(readings(values), { config: { maxExamples: 2 } })
  assert.equal(columnNamed(overLimit, 'reading').numeric.outlierCount, 3)
  assert.equal(columnNamed(overLimit, 'reading').numeric.examples.length, 2)
  assert.equal(findingsFor(overLimit, 'examples-limited').length, 1)
  // The COUNT stays exact. Only the listing is limited, which is why this is
  // information and not a gap in the evidence.
  assert.ok(findingsFor(overLimit, 'examples-limited')[0].message.includes('The count is exact'))
  assert.equal(overLimit.status, 'fail')
})

test('a column entry shows exactly the top-category cap, and says so when it shortens the list', async () => {
  const ten = Array.from({ length: MAX_TOP_CATEGORIES }, (_, index) => `v${index}`)
  const baseline = { columns: { id: {}, region: { allowed: [...ten, 'v10'] } } }

  // At the cap: the whole index is listed and there is nothing to report.
  const atLimit = await profileText(categorical(ten), { baseline })
  assert.equal(columnNamed(atLimit, 'region').categories.top.length, MAX_TOP_CATEGORIES)
  assert.equal(findingsFor(atLimit, 'examples-limited').length, 0)
  assert.equal(atLimit.status, 'pass')

  // One past it: the list is shortened, and the README's promise is that no
  // limit shortens anything in silence. The COUNT stays exact, which is why
  // this is information rather than a gap in the evidence.
  const overLimit = await profileText(categorical([...ten, 'v10']), { baseline })
  const region = columnNamed(overLimit, 'region')
  assert.equal(region.categories.distinct, MAX_TOP_CATEGORIES + 1)
  assert.equal(region.categories.top.length, MAX_TOP_CATEGORIES)
  const limited = findingsFor(overLimit, 'examples-limited')
  assert.equal(limited.length, 1)
  assert.equal(limited[0].severity, 'info')
  assert.ok(limited[0].message.includes(`${MAX_TOP_CATEGORIES + 1} distinct value or values`))
  assert.ok(limited[0].message.includes('The count is exact'))
  // Information, not a gap: the run still ends where it would have ended.
  assert.equal(overLimit.status, 'pass')
})
