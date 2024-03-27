/**
 * What a column looks like, and what this tool is prepared to say about it.
 *
 * Every counter here exists so that a verdict can be refused honestly. A
 * profile that reports a clean distribution over six rows has told you nothing
 * and made it look like something, so a column that cannot support a verdict
 * gets `undetermined` and a reason -- never a quiet absence of findings.
 *
 * The three refusals, and what each one is protecting against:
 *
 *   sample-too-small       an order statistic over a handful of points is not
 *                          a description of a distribution
 *   dispersion-degenerate  a zero deviation makes the score a division by zero,
 *                          which reports every value that is not the median as
 *                          outlying: a confident answer produced by arithmetic
 *                          rather than by evidence
 *   column-mixed-types     a median over the subset of a column that happens to
 *                          parse as a number describes no column that exists
 */

import {
  MAD_CONSTANT,
  median,
  medianAbsoluteDeviation,
  modifiedZScore,
  quantile,
  sortedCopy,
} from './stats.mjs'
import { byCodeUnit, hasUnprintableCharacter, num, renderedForm } from './text.mjs'

export const COLUMN_TYPES = Object.freeze(['numeric', 'categorical', 'mixed', 'undetermined'])
export const VERDICTS = Object.freeze(['evaluated', 'undetermined'])

/**
 * What this tool accepts as a number.
 *
 * Surrounding spaces and tabs are ignored, because a delimited export pads
 * columns. Nothing else is: `1,234` is two fields to a reader of this format and
 * a thousands separator to a person, and this tool does not choose between
 * them.
 */
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

export function asNumber(text) {
  const trimmed = text.replace(/^[ \t]+/u, '').replace(/[ \t]+$/u, '')
  if (!NUMERIC.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : null
}

export function newColumn(name, index, tracksCategories) {
  return {
    name,
    index,
    tracksCategories,
    total: 0,
    missing: 0,
    numeric: 0,
    other: 0,
    oversized: 0,
    unprintable: 0,
    categoryOversized: 0,
    categoryDropped: 0,
    reshaped: 0,
    categoriesTruncated: false,
    values: [],
    rows: [],
    categories: new Map(),
  }
}

/**
 * Record one field of one row.
 *
 * `row` is the line number a person would count to in the file, starting at 1
 * for the header, so that a finding can be acted on.
 */
export function observeField(column, field, row, config) {
  const { limits, missingTokens } = config
  column.total += 1
  if (field.truncated) {
    column.oversized += 1
    return
  }
  const text = field.text
  if (missingTokens.includes(text)) {
    column.missing += 1
    return
  }
  // What a reader will see. Everything below asks about this form, because a
  // question answered about the raw text and reported about the rendered one is
  // two functions disagreeing about one value.
  const rendered = renderedForm(text)
  if (hasUnprintableCharacter(text) || rendered === '') {
    // A value carrying a control or formatting character, or one that prints as
    // nothing at all, does not print as it is stored. It is a value, so it is
    // not missing; it cannot be shown or indexed, so it is not examined either.
    column.unprintable += 1
    return
  }
  // A value whose stored text differs from the text this report prints is
  // counted in every column, tracked or not, so that nothing is profiled whose
  // rendering silently differs from what is in the file.
  if (rendered !== text) column.reshaped += 1
  const value = asNumber(text)
  if (value === null) column.other += 1
  else {
    column.numeric += 1
    column.values.push(value)
    column.rows.push(row)
  }
  if (!column.tracksCategories) return
  // The rendered form is what the index retains, so it is what the length bound
  // measures: a padded value inside the bound once printed is not an oversized
  // one.
  if (rendered.length > limits.maxCategoryLength) {
    column.categoryOversized += 1
    return
  }
  const seen = column.categories.get(rendered)
  if (seen === undefined && column.categories.size >= limits.maxDistinctCategories) {
    // The value is evidence this comparison did not get, exactly like a value
    // over the length bound. It is counted HERE, where it is dropped: a count
    // assembled later from the other counters reported zero beside the
    // admission that the index had been truncated.
    column.categoriesTruncated = true
    column.categoryDropped += 1
    return
  }
  column.categories.set(rendered, (seen ?? 0) + 1)
}

export function examinedCount(column) {
  return column.total - column.missing - column.oversized - column.unprintable
}

export function typeOf(column) {
  const examined = examinedCount(column)
  if (examined <= 0) return 'undetermined'
  if (column.numeric === examined) return 'numeric'
  if (column.numeric === 0) return 'categorical'
  return 'mixed'
}

/**
 * The numeric verdict, or the reason there is none.
 *
 * Nothing below computes a score until the sample and the dispersion have both
 * been established, and neither check has a path that produces a number anyway.
 */
export function numericVerdict(column, config) {
  const kind = typeOf(column)
  if (kind === 'categorical') return null
  if (kind === 'undetermined') {
    return { verdict: 'undetermined', reason: 'no-values-examined', method: config.method }
  }
  if (kind === 'mixed') {
    return {
      verdict: 'undetermined',
      reason: 'mixed-types',
      method: config.method,
      examined: examinedCount(column),
      numeric: column.numeric,
      other: column.other,
    }
  }
  const examined = examinedCount(column)
  if (examined < config.minSample) {
    return {
      verdict: 'undetermined',
      reason: 'sample-too-small',
      method: config.method,
      examined,
      minSample: config.minSample,
    }
  }

  const sorted = sortedCopy(column.values)
  const centre = median(sorted)
  const dispersion = config.method === 'mad'
    ? medianAbsoluteDeviation(sorted, centre)
    : quantile(sorted, 0.75) - quantile(sorted, 0.25)

  if (dispersion === 0) {
    return {
      verdict: 'undetermined',
      reason: 'dispersion-degenerate',
      method: config.method,
      examined,
      median: num(centre),
      dispersion: 0,
    }
  }

  const outliers = []
  if (config.method === 'mad') {
    for (let index = 0; index < column.values.length; index += 1) {
      const score = modifiedZScore(column.values[index], centre, dispersion)
      if (Math.abs(score) > config.outlierThreshold) {
        outliers.push({ row: column.rows[index], value: column.values[index], score: num(score) })
      }
    }
  } else {
    const low = quantile(sorted, 0.25) - config.iqrMultiplier * dispersion
    const high = quantile(sorted, 0.75) + config.iqrMultiplier * dispersion
    for (let index = 0; index < column.values.length; index += 1) {
      const value = column.values[index]
      if (value < low || value > high) {
        const distance = value < low ? low - value : value - high
        outliers.push({ row: column.rows[index], value, score: num(distance / dispersion) })
      }
    }
  }

  // Strongest first, then by row: two values with the same score must not swap
  // places between runs.
  outliers.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.row - b.row)

  return {
    verdict: 'evaluated',
    reason: null,
    method: config.method,
    examined,
    median: num(centre),
    dispersion: num(dispersion),
    threshold: config.method === 'mad' ? config.outlierThreshold : config.iqrMultiplier,
    constant: config.method === 'mad' ? MAD_CONSTANT : null,
    fences: config.method === 'iqr'
      ? {
        low: num(quantile(sorted, 0.25) - config.iqrMultiplier * dispersion),
        high: num(quantile(sorted, 0.75) + config.iqrMultiplier * dispersion),
      }
      : null,
    outlierCount: outliers.length,
    examples: outliers.slice(0, config.maxExamples).map((outlier) => ({
      row: outlier.row,
      value: num(outlier.value),
      score: outlier.score,
    })),
  }
}

/**
 * Whether the observed category index holds everything the column contained.
 *
 * A comparison against an index that dropped evidence is INCOMPLETE, not clean.
 * The values that are in the index can still be checked against the baseline --
 * a value seen and not permitted is a value seen and not permitted, whatever
 * else was dropped -- but the opposite claim, that the column contains nothing
 * unexpected, is not available and is not made.
 */
export function categoryIndexComplete(column) {
  return (
    column.tracksCategories
    && !column.categoriesTruncated
    && column.categoryOversized === 0
    && column.oversized === 0
    && column.unprintable === 0
  )
}

export function unexpectedCategories(column, allowed) {
  const unexpected = []
  for (const [value, count] of column.categories) {
    if (!allowed.includes(value)) unexpected.push({ value, count })
  }
  return unexpected.sort((a, b) => byCodeUnit(a.value, b.value))
}

/** Total variation distance between the observed shares and the declared ones. */
export function categoryDistance(column, baselineCategories) {
  let observedTotal = 0
  for (const count of column.categories.values()) observedTotal += count
  if (observedTotal === 0) return null
  const keys = new Set([...column.categories.keys(), ...baselineCategories.keys()])
  let sum = 0
  for (const key of keys) {
    const observed = (column.categories.get(key) ?? 0) / observedTotal
    const declared = baselineCategories.get(key) ?? 0
    sum += Math.abs(observed - declared)
  }
  return num(sum / 2)
}

export function missingRateOf(column) {
  return column.total === 0 ? null : num(column.missing / column.total)
}

/** The categories a report shows, strongest first and then by value. */
export function topCategories(column, limit) {
  return [...column.categories.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || byCodeUnit(a.value, b.value))
    .slice(0, limit)
}
