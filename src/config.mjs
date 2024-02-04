/**
 * The configuration document: which method runs, the thresholds it runs at, and
 * the limits.
 *
 * The configuration is POLICY, not evidence. A problem with it means the run
 * never had a subject, so every failure here is a `ConfigError`: the process
 * exits 2 with an EMPTY stdout and the message on stderr.
 *
 * Unknown keys are refused rather than ignored. A one-character typo in a
 * threshold name must not turn a real failure into a green run -- that has
 * happened in this catalog, and the key was documented.
 *
 * The limits are checked as a SET, not one at a time. Two products decide how
 * much memory a run can need -- rows times columns for the retained numbers,
 * and columns times distinct categories times category length for the category
 * index -- and both are checked here, before a file is opened, so a document
 * this tool calls legal cannot exhaust memory.
 */

import { hasUnsafeCharacter, sanitize } from './text.mjs'

export class ConfigError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const CONFIG_SCHEMA_VERSION = '1'

/** The configuration and baseline documents are bounded before they are read. */
export const MAX_CONFIG_BYTES = 65536
export const MAX_BASELINE_BYTES = 1048576

export const METHODS = Object.freeze(['mad', 'iqr'])

export const DEFAULT_LIMITS = Object.freeze({
  maxBytes: 33554432,
  maxRows: 20000,
  maxColumns: 100,
  maxFieldLength: 8192,
  maxDistinctCategories: 512,
  maxCategoryLength: 128,
})

export const LIMIT_CEILINGS = Object.freeze({
  maxBytes: 134217728,
  maxRows: 200000,
  maxColumns: 1024,
  maxFieldLength: 65536,
  maxDistinctCategories: 4096,
  maxCategoryLength: 1024,
})

export const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))

/** The most numeric values one run may retain: rows multiplied by columns. */
export const MAX_CELLS = 2000000

/** The most characters one run may retain across every category index. */
export const MAX_CATEGORY_CHARACTERS = 33554432

export const MAX_MISSING_TOKENS = 16

export const NUMBER_RANGES = Object.freeze({
  minSample: { min: 4, max: 100000, integer: true, fallback: 12 },
  outlierThreshold: { min: 0, max: 100, integer: false, fallback: 3.5, exclusiveMin: true },
  iqrMultiplier: { min: 0, max: 100, integer: false, fallback: 1.5, exclusiveMin: true },
  maxMissingRate: { min: 0, max: 1, integer: false, fallback: 0.2 },
  maxMissingRateDrift: { min: 0, max: 1, integer: false, fallback: 0.1 },
  maxCategoryDrift: { min: 0, max: 1, integer: false, fallback: 0.2 },
  maxExamples: { min: 1, max: 100, integer: true, fallback: 8 },
})

export const CONFIG_KEYS = Object.freeze([
  'schemaVersion',
  'method',
  'missingTokens',
  'limits',
  ...Object.keys(NUMBER_RANGES),
])

export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function refuse(message) {
  throw new ConfigError(message)
}

function validateLimits(raw) {
  const limits = { ...DEFAULT_LIMITS }
  if (raw !== undefined) {
    if (!isRecord(raw)) refuse('The configuration key "limits" must be an object.')
    for (const key of Object.keys(raw)) {
      if (!LIMIT_NAMES.includes(key)) {
        refuse(`Unknown limit "${sanitize(key, 64)}". Known limits: ${LIMIT_NAMES.join(', ')}.`)
      }
    }
    for (const key of LIMIT_NAMES) {
      if (raw[key] === undefined) continue
      const value = raw[key]
      if (!Number.isSafeInteger(value) || value < 1 || value > LIMIT_CEILINGS[key]) {
        refuse(
          `The limit "${key}" must be a whole number from 1 to ${LIMIT_CEILINGS[key]}, `
          + `and it was ${sanitize(value, 64)}.`,
        )
      }
      limits[key] = value
    }
  }
  const cells = limits.maxRows * limits.maxColumns
  if (cells > MAX_CELLS) {
    refuse(
      `maxRows multiplied by maxColumns is ${cells}, which is more than the ${MAX_CELLS} values one run `
      + `may retain. Lower one of them.`,
    )
  }
  const characters = limits.maxColumns * limits.maxDistinctCategories * limits.maxCategoryLength
  if (characters > MAX_CATEGORY_CHARACTERS) {
    refuse(
      `maxColumns multiplied by maxDistinctCategories and maxCategoryLength is ${characters}, which is `
      + `more than the ${MAX_CATEGORY_CHARACTERS} characters one run may retain across every category `
      + `index. Lower one of them.`,
    )
  }
  return limits
}

function validateNumber(name, value) {
  const range = NUMBER_RANGES[name]
  if (value === undefined) return range.fallback
  const wrong = typeof value !== 'number'
    || !Number.isFinite(value)
    || (range.integer && !Number.isInteger(value))
    || value > range.max
    || (range.exclusiveMin ? value <= range.min : value < range.min)
  if (wrong) {
    refuse(
      `"${name}" must be a ${range.integer ? 'whole number' : 'number'} `
      + `${range.exclusiveMin ? 'above' : 'from'} ${range.min} to ${range.max}, `
      + `and it was ${sanitize(value, 64)}.`,
    )
  }
  return value
}

function validateMissingTokens(raw, limits) {
  if (raw === undefined) return ['']
  if (!Array.isArray(raw)) refuse('The configuration key "missingTokens" must be an array of strings.')
  if (raw.length > MAX_MISSING_TOKENS) {
    refuse(`"missingTokens" holds ${raw.length} entries, which is more than the ${MAX_MISSING_TOKENS} allowed.`)
  }
  const tokens = []
  for (const token of raw) {
    // A token may be whitespace -- a column of single spaces is a real export
    // -- but it may not carry anything that would forge or hide a line in the
    // report, because the configuration is echoed back in it.
    if (hasUnsafeCharacter(token) || token.length > limits.maxCategoryLength) {
      refuse(
        `Every "missingTokens" entry must be a string of at most ${limits.maxCategoryLength} characters `
        + `with no control or formatting character, and "${sanitize(token, 64)}" is not.`,
      )
    }
    if (tokens.includes(token)) refuse(`The missing token "${sanitize(token, 64)}" is listed twice.`)
    tokens.push(token)
  }
  return tokens
}

export function validateConfig(document) {
  if (!isRecord(document)) refuse('The configuration document must be a JSON object.')
  for (const key of Object.keys(document)) {
    if (!CONFIG_KEYS.includes(key)) {
      refuse(`Unknown configuration key "${sanitize(key, 64)}". Known keys: ${CONFIG_KEYS.join(', ')}.`)
    }
  }
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    refuse(
      `The configuration declares schemaVersion ${sanitize(document.schemaVersion, 32)}; `
      + `this tool reads version ${CONFIG_SCHEMA_VERSION}.`,
    )
  }
  const method = document.method ?? 'mad'
  if (!METHODS.includes(method)) {
    refuse(`"method" must be one of ${METHODS.join(', ')}, and it was ${sanitize(method, 32)}.`)
  }
  const limits = validateLimits(document.limits)
  const numbers = {}
  for (const name of Object.keys(NUMBER_RANGES)) numbers[name] = validateNumber(name, document[name])
  return Object.freeze({
    method,
    ...numbers,
    missingTokens: Object.freeze(validateMissingTokens(document.missingTokens, limits)),
    limits: Object.freeze(limits),
  })
}

export function defaultConfig() {
  return validateConfig({ schemaVersion: CONFIG_SCHEMA_VERSION })
}
