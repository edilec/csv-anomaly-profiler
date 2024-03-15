/**
 * The boundary every untrusted string crosses on its way to output, plus the
 * two things that decide whether the output can be trusted at all: how a parse
 * failure is described, and what this tool is allowed to say about its own
 * work.
 *
 * Three defences live here, and each exists because its absence produced a real
 * defect in this catalog:
 *
 * 1. `sanitize` is the ONE boundary. Column names, category values, evidence
 *    and messages all pass through it -- not only an `evidence` field. A
 *    shipped tool sanitised its evidence carefully and let an identifier
 *    carrying a newline forge whole lines in the report, and a CSV column
 *    header is exactly that kind of identifier.
 * 2. `parseFailureDetail` recognises the quoting shape BEFORE looking for a
 *    position. A baseline document that literally reads `at position 1` makes
 *    V8 quote it back, and a position-first helper slices the document out of
 *    its own error message.
 * 3. `msg` splits this tool's own literals from interpolated values. The
 *    literals are checked for claims this tool is not entitled to make; the
 *    values, which come from untrusted documents, are sanitised. The scan looks
 *    at what this tool WROTE, never at what it read -- a CSV column literally
 *    named `root_cause` is data and must not stop the run.
 */

/** Deterministic order: UTF-16 code unit, never locale collation. */
export function byCodeUnit(a, b) {
  return a === b ? 0 : a < b ? -1 : 1
}

/**
 * U+2028 and U+2029, written as escape text so that no editor, transfer or
 * copy-paste can quietly turn the escape into the character it names.
 */
export const LINE_SEPARATORS = '\u2028\u2029'

/**
 * Everything stripped from an untrusted string before it reaches output.
 *
 * `\p{Cc}` is C0, DEL and C1: U+0085 and U+009B forge lines in a human report
 * just as U+000A does, and stripping C0 alone has shipped as a bug four times
 * in this catalog. `\p{Cf}` is the bidi controls and the other invisible format
 * characters, which reorder or hide displayed text. The two separators belong
 * to neither class and have to be named.
 */
const UNSAFE_CHARACTERS = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'gu')

/** Whether a string carries anything that would forge or hide text in a report. */
export function hasUnsafeCharacter(value) {
  return typeof value !== 'string' || new RegExp(UNSAFE_CHARACTERS.source, 'u').test(value)
}

export const EVIDENCE_LIMIT = 200
export const MAX_NAME_LENGTH = 128

/**
 * Describe any value as a string without ever letting it stop the run.
 *
 * `String({ toString: {} })` throws `Cannot convert object to primitive value`,
 * and a baseline is JSON this tool did not write: `{"a": {"toString": {}}}`
 * parses into exactly that. A value that will not convert is described by its
 * shape and never reproduced.
 */
export function describeValue(value) {
  if (typeof value === 'string') return value
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return '[array]'
  try {
    return String(value)
  } catch {
    return typeof value === 'function' ? '[function]' : '[object]'
  }
}

/** A bounded, control-character-free rendering of an untrusted string. */
export function sanitize(value, limit = EVIDENCE_LIMIT) {
  const flat = describeValue(value)
    .replace(UNSAFE_CHARACTERS, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat
}

/**
 * Whether a name may be used as an identity in this report.
 *
 * Stricter than "renders to something", and deliberately so. A header that
 * merely SURVIVES sanitising is not safe as an identity: `a<U+0001>b` and `a b`
 * both print as `a b`, so one column would silently become the other in the
 * report while remaining two different columns in the file. Requiring the name
 * to print EXACTLY as it is stored removes the collision.
 *
 * `value.trim().length > 0` is the wrong question and has shipped as a bug:
 * `trim` removes ECMAScript whitespace only, so a header of U+0001 or U+200E
 * passes it and then prints as nothing at all.
 */
export function isUsableName(value, limit = MAX_NAME_LENGTH) {
  return (
    typeof value === 'string'
    && value.length > 0
    && value.length <= limit
    && sanitize(value, limit) === value
  )
}

/**
 * A number as a report prints it: at most six decimals, never negative zero.
 *
 * Rounding must never turn a value that is not zero INTO zero. A dispersion of
 * 0.0000003 printed as `0` sits beside a verdict computed from a dispersion
 * that is not zero, and a distance of 0.0000004 printed as `0` says two
 * distributions are identical when they are not -- two numbers disagreeing
 * about the same thing, which is the same defect as a check that asks about the
 * raw value while the renderer shows something else. A value too small to
 * survive the rounding is printed as it is.
 */
export function num(value) {
  if (!Number.isFinite(value)) return null
  const rounded = Math.round(value * 1000000) / 1000000
  if (rounded === 0 && value !== 0) return value
  return Object.is(rounded, -0) ? 0 : rounded
}

export const UNPARSEABLE = 'the document could not be parsed as JSON'

/** Where V8 puts the offending offset. Safe: an offset says nothing about content. */
const POSITION = /at position \d+(?: \(line \d+ column \d+\))?/u

/**
 * The shape that quotes the input. Recognised FIRST, and the order is the whole
 * guard: a document whose own text reads `at position 1` makes V8 write
 * `Unexpected token 'a', "at position 1" is not valid JSON`, so looking for the
 * offset first finds that phrase INSIDE the quoted span and slices the document
 * straight back out. The `s` flag matters too -- the quoted span can carry a
 * newline, and a non-dotAll pattern silently fails to recognise the shape it is
 * there to catch. A leading `...` means the quoted run came from the middle of
 * the document rather than its start.
 */
const QUOTES_THE_INPUT = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/su

function describeParseFailure(message) {
  const quoting = QUOTES_THE_INPUT.exec(message)
  if (quoting !== null) {
    const where = quoting[2] === undefined ? 'at the start of the document' : 'inside the document'
    return `unexpected token ${quoting[1]} ${where}`
  }
  const position = POSITION.exec(message)
  if (position !== null) return message.slice(0, position.index + position[0].length)
  if (message === 'Unexpected end of JSON input') return message
  return UNPARSEABLE
}

/**
 * Say what a `JSON.parse` failure was, without reproducing the document.
 *
 * V8 reports a parse failure two ways and one of them quotes the input back:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A baseline
 * short enough to be one credential is therefore reproduced in full by its own
 * error message, and `sanitize` does not stop that -- it strips control
 * characters and cuts from the end, while the quoted input sits at the front.
 *
 * The closing guard is deliberate belt and braces and is why this function is
 * safe against wordings it has never seen: across the measured corpus of V8
 * parse messages, every message carrying no quoted snippet carries no double
 * quote at all, because V8 quotes JSON punctuation with apostrophes. A double
 * quote surviving to the end therefore means a snippet survived, whatever the
 * branches above concluded, and the generic sentence is used instead.
 */
export function parseFailureDetail(error) {
  const message = describeValue(error?.message ?? '')
  const detail = describeParseFailure(message)
  return detail.includes('"') ? UNPARSEABLE : detail
}

/**
 * Claims this tool is not entitled to make about its own work.
 *
 * It reads a delimited file and a baseline document. It runs a robust
 * dispersion test over the numbers it could read, and that is all: it does no
 * hypothesis test, it fits no model, and a point outside a fence is a point
 * outside a fence, not an error in the data and not the effect of a cause. A
 * sentence phrased as though it were more would describe a capability this tool
 * does not have, so the phrasing is refused at construction time rather than at
 * review time.
 *
 * Only this tool's OWN literals are scanned, never the file.
 */
export const FORBIDDEN_CLAIMS = Object.freeze([
  'guaranteed', 'guarantees', 'certainly', 'definitely', 'proves', 'proven',
  'exhaustive', 'infallible', 'anomaly free', 'anomaly-free',
  'statistically significant', 'significance', 'p-value', 'confidence interval',
  'root cause', 'caused by', 'the cause', 'because the data',
  'the data is clean', 'no anomalies exist', 'normally distributed',
  'this value is wrong', 'this value is an error',
])

const FORBIDDEN_PATTERN = new RegExp(
  `\\b(?:${FORBIDDEN_CLAIMS.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|')})\\b`,
  'iu',
)

export function findForbiddenClaim(text) {
  const match = FORBIDDEN_PATTERN.exec(describeValue(text))
  return match === null ? null : match[0]
}

export function assertNoForbiddenClaim(text, what) {
  const term = findForbiddenClaim(text)
  if (term !== null) {
    throw new Error(
      `${what} may not claim more than a robust dispersion test supports: "${term}". This tool reads a `
      + `delimited file and reports what the numbers in it look like.`,
    )
  }
}

/**
 * A message whose literals have been checked and whose values are sanitised.
 *
 * It is the OUTPUT of `msg` and nothing else should construct one: the class
 * carries the fact that its literals have already been through the claim check,
 * and constructing one directly around unchecked prose would assert something
 * that is not true. It is deliberately NOT checked in the constructor, because
 * by then the text also holds sanitised values from an untrusted document, and
 * a document whose field is named `proven_customer` must not stop the run.
 */
export class SafeMessage {
  constructor(text) {
    this.text = text
    Object.freeze(this)
  }

  toString() {
    return this.text
  }
}

/** Build a finding message: checked literals, sanitised values. */
export function msg(strings, ...values) {
  let out = ''
  for (let index = 0; index < strings.length; index += 1) {
    // Runs of whitespace in this tool's own literals collapse to one space, so
    // a sentence may be wrapped across source lines without wrapping the
    // report, and so a phrase this tool may not use cannot be hidden by a line
    // break.
    const literal = strings[index].replace(/\s+/gu, ' ')
    assertNoForbiddenClaim(literal, 'A finding message')
    out += literal
    if (index < values.length) {
      const value = values[index]
      // A SafeMessage is this tool's own prose that has ALREADY been through
      // the claim check, so it is inserted verbatim. Everything else came from
      // a document and is only sanitised. Without this branch, a message built
      // in two halves would have to interpolate its second half as a value --
      // and prose interpolated as a value is prose the claim check never sees,
      // which is the guard failing silently in the direction that matters.
      out += value instanceof SafeMessage ? value.text : sanitize(value)
    }
  }
  return new SafeMessage(out)
}

export function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

/** JSON Pointer escaping, applied to an already sanitised token. */
export function pointerToken(value) {
  return sanitize(value, MAX_NAME_LENGTH).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

/** The pointer form this tool documents: `/columns/<name>`. */
export function pointerForColumn(name) {
  return `/columns/${pointerToken(name)}`
}
