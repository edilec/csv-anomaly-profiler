/**
 * The baseline document: what the columns looked like last time.
 *
 * The baseline is POLICY, like the configuration. The caller chooses it, and it
 * is the INDEX every drift and category comparison is made against -- so an
 * entry that could not be used is refused when the document is read, and never
 * dropped quietly.
 *
 * That ordering is the whole point of this file. Evidence dropped while
 * building an index makes every comparison against that index incomplete; it
 * does not make the comparison clean. A tool in this catalog dropped the values
 * it could not evaluate out of its index and then asserted POSITIVELY that a
 * literal matched nothing in the group, and exited 0. Refusing the document
 * here means the index this tool compares against is either whole or absent,
 * and there is no third state for a later comparison to misread.
 *
 * A baseline is optional. With none, this tool makes no claim about drift or
 * about unexpected categories at all -- not "no drift", not "no unexpected
 * values". It simply does not answer a question nobody gave it the evidence
 * for.
 */

import { hasUnsafeCharacter, isUsableName, renderedForm, sanitize } from './text.mjs'
import { ConfigError } from './config.mjs'

export const BASELINE_SCHEMA_VERSION = '1'

export const BASELINE_KEYS = Object.freeze(['schemaVersion', 'source', 'columns'])
export const BASELINE_COLUMN_KEYS = Object.freeze(['missingRate', 'allowed', 'categories'])

/** How far a declared distribution may sum away from one before it is refused. */
export const DISTRIBUTION_TOLERANCE = 0.001

function refuse(message) {
  throw new ConfigError(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function validateCategoryValue(value, where, limits) {
  if (hasUnsafeCharacter(value) || value.length > limits.maxCategoryLength) {
    refuse(
      `Every category in ${where} must be a string of at most ${limits.maxCategoryLength} characters with `
      + `no control or formatting character, and "${sanitize(value, 64)}" is not.`,
    )
  }
  // An observed value is indexed by the form the report prints, so a declared
  // value that prints differently from the way it is written could never match
  // one -- and the finding would print the two as the same text while calling
  // them different. The ambiguity is refused in the policy document, where it
  // can be corrected, rather than carried into a comparison.
  if (value.length === 0 || renderedForm(value) !== value) {
    refuse(
      `Every category in ${where} must print exactly as it is written, and "${sanitize(value, 64)}" does `
      + `not: it is empty, or it carries leading, trailing or repeated whitespace. Observed values are `
      + `compared as they print.`,
    )
  }
}

function validateColumn(name, raw, limits) {
  if (!isRecord(raw)) refuse(`The baseline entry for "${sanitize(name, 64)}" must be an object.`)
  for (const key of Object.keys(raw)) {
    if (!BASELINE_COLUMN_KEYS.includes(key)) {
      refuse(
        `Unknown baseline key "${sanitize(key, 64)}" for column "${sanitize(name, 64)}". `
        + `Known keys: ${BASELINE_COLUMN_KEYS.join(', ')}.`,
      )
    }
  }

  const entry = { missingRate: null, allowed: null, categories: null }

  if (raw.missingRate !== undefined) {
    const rate = raw.missingRate
    if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
      refuse(`The baseline missingRate for "${sanitize(name, 64)}" must be a number from 0 to 1.`)
    }
    entry.missingRate = rate
  }

  if (raw.allowed !== undefined) {
    if (!Array.isArray(raw.allowed)) {
      refuse(`The baseline "allowed" list for "${sanitize(name, 64)}" must be an array of strings.`)
    }
    if (raw.allowed.length > limits.maxDistinctCategories) {
      refuse(
        `The baseline "allowed" list for "${sanitize(name, 64)}" holds ${raw.allowed.length} entries, `
        + `which is more than the ${limits.maxDistinctCategories} this run indexes.`,
      )
    }
    const allowed = []
    for (const value of raw.allowed) {
      validateCategoryValue(value, `the "allowed" list for "${sanitize(name, 64)}"`, limits)
      if (allowed.includes(value)) {
        refuse(`The baseline "allowed" list for "${sanitize(name, 64)}" lists "${sanitize(value, 64)}" twice.`)
      }
      allowed.push(value)
    }
    entry.allowed = allowed
  }

  if (raw.categories !== undefined) {
    if (!isRecord(raw.categories)) {
      refuse(`The baseline "categories" for "${sanitize(name, 64)}" must be an object of shares.`)
    }
    const keys = Object.keys(raw.categories)
    if (keys.length === 0) {
      refuse(`The baseline "categories" for "${sanitize(name, 64)}" is empty, so it is not a distribution.`)
    }
    if (keys.length > limits.maxDistinctCategories) {
      refuse(
        `The baseline "categories" for "${sanitize(name, 64)}" holds ${keys.length} entries, which is `
        + `more than the ${limits.maxDistinctCategories} this run indexes.`,
      )
    }
    const categories = new Map()
    let total = 0
    for (const key of keys) {
      validateCategoryValue(key, `the "categories" of "${sanitize(name, 64)}"`, limits)
      const share = raw.categories[key]
      if (typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1) {
        refuse(
          `The baseline share for "${sanitize(key, 64)}" in "${sanitize(name, 64)}" must be a number `
          + `from 0 to 1.`,
        )
      }
      categories.set(key, share)
      total += share
    }
    // A set of shares that does not sum to one is not a distribution, and a
    // distance computed against it would be a number with no meaning.
    if (Math.abs(total - 1) > DISTRIBUTION_TOLERANCE) {
      refuse(
        `The baseline "categories" for "${sanitize(name, 64)}" sum to ${total}, and a distribution `
        + `must sum to 1 within ${DISTRIBUTION_TOLERANCE}.`,
      )
    }
    entry.categories = categories
  }

  return entry
}

export function validateBaseline(document, limits) {
  if (!isRecord(document)) refuse('The baseline document must be a JSON object.')
  for (const key of Object.keys(document)) {
    if (!BASELINE_KEYS.includes(key)) {
      refuse(`Unknown baseline key "${sanitize(key, 64)}". Known keys: ${BASELINE_KEYS.join(', ')}.`)
    }
  }
  if (document.schemaVersion !== BASELINE_SCHEMA_VERSION) {
    refuse(
      `The baseline declares schemaVersion ${sanitize(document.schemaVersion, 32)}; `
      + `this tool reads version ${BASELINE_SCHEMA_VERSION}.`,
    )
  }
  if (document.source !== undefined && !isUsableName(document.source)) {
    refuse('The baseline "source" must be a short name that prints exactly as it is written.')
  }
  if (!isRecord(document.columns)) refuse('The baseline must carry a "columns" object.')
  const names = Object.keys(document.columns)
  if (names.length === 0) refuse('The baseline "columns" object is empty, so there is nothing to compare against.')
  if (names.length > limits.maxColumns) {
    refuse(
      `The baseline describes ${names.length} columns, which is more than the ${limits.maxColumns} `
      + `this run profiles.`,
    )
  }
  const columns = new Map()
  for (const name of names) {
    if (!isUsableName(name)) {
      refuse(
        `The baseline column name "${sanitize(name, 64)}" must print exactly as it is written and be at `
        + `most 128 characters, so that it can be matched against a header.`,
      )
    }
    columns.set(name, validateColumn(name, document.columns[name], limits))
  }
  return Object.freeze({ source: document.source ?? null, columns })
}
