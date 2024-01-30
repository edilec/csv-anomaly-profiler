/**
 * A streaming delimited-text reader.
 *
 * It holds one field and one row at a time, both bounded, so the memory a run
 * needs does not grow with the size of the file. A value longer than the field
 * bound stops being accumulated and is marked truncated rather than kept, which
 * is the difference between a bound and a hope.
 *
 * Three decisions about ambiguous input, written down because each one is a
 * place a reader could invent something:
 *
 * 1. A quote only opens a field at its start. RFC 4180 gives the quote meaning
 *    only in that position, so a quote inside an unquoted field is an ordinary
 *    character and is kept as one.
 * 2. Text after a closing quote -- `"ab"c` -- has no reading in the grammar. It
 *    is reported as a malformed row and the row is not profiled, rather than
 *    guessed at.
 * 3. A record ends at LF or CRLF. A lone CR is an ordinary character, because
 *    treating it as a record separator would silently split a value that
 *    legitimately contains one. It will be reported later as a value that does
 *    not print as it is stored.
 */

const QUOTE = '"'
const COMMA = ','
const CR = '\r'
const LF = '\n'
const BOM = '\ufeff'

/** The shapes of malformed input this reader reports. */
export const CSV_PROBLEMS = Object.freeze(['text-after-quote', 'unterminated-quote'])

/**
 * Create the reader.
 *
 * `onRow` receives `{ index, fields, fieldCount, malformed }` where `fields` is
 * an array of `{ text, truncated }` capped at `maxColumns` entries and
 * `fieldCount` is how many fields the row actually had. Returning `false` from
 * `onRow` stops the reader: the caller owns the row bound, because only the
 * caller knows what it means.
 */
export function createCsvReader({ maxFieldLength, maxColumns, onRow, onProblem }) {
  let state = 'field-start'
  let field = ''
  let truncated = false
  let fields = []
  let fieldCount = 0
  let malformed = false
  let pending = false
  let index = 0
  let stopped = false
  let seenAnything = false

  const pushField = () => {
    fieldCount += 1
    if (fields.length < maxColumns) fields.push({ text: field, truncated })
    field = ''
    truncated = false
  }

  const finishRow = () => {
    pushField()
    const row = { index, fields, fieldCount, malformed }
    index += 1
    fields = []
    fieldCount = 0
    malformed = false
    pending = false
    state = 'field-start'
    if (onRow(row) === false) stopped = true
  }

  const append = (character) => {
    if (field.length >= maxFieldLength) {
      truncated = true
      return
    }
    field += character
  }

  const push = (text) => {
    if (stopped) return
    let start = 0
    if (!seenAnything) {
      seenAnything = true
      if (text.startsWith(BOM)) start = 1
    }
    for (let position = start; position < text.length; position += 1) {
      if (stopped) return
      const character = text[position]
      pending = true
      if (state === 'field-start') {
        if (character === QUOTE) {
          state = 'in-quoted'
        } else if (character === COMMA) {
          pushField()
        } else if (character === LF) {
          finishRow()
        } else if (character === CR) {
          state = 'maybe-newline'
        } else {
          state = 'in-field'
          append(character)
        }
        continue
      }
      if (state === 'in-field') {
        if (character === COMMA) {
          pushField()
          state = 'field-start'
        } else if (character === LF) {
          finishRow()
        } else if (character === CR) {
          state = 'maybe-newline'
        } else {
          append(character)
        }
        continue
      }
      if (state === 'maybe-newline') {
        if (character === LF) {
          finishRow()
          continue
        }
        // A lone CR: an ordinary character, kept as one.
        append(CR)
        state = 'in-field'
        position -= 1
        continue
      }
      if (state === 'in-quoted') {
        if (character === QUOTE) state = 'quote-in-quoted'
        else append(character)
        continue
      }
      if (state === 'maybe-newline-after-quote') {
        if (character === LF) {
          finishRow()
          continue
        }
        malformed = true
        onProblem({ kind: 'text-after-quote', row: index })
        state = 'in-field'
        append(CR)
        position -= 1
        continue
      }
      // quote-in-quoted: the quote just read closed the field, or doubles.
      if (character === QUOTE) {
        append(QUOTE)
        state = 'in-quoted'
      } else if (character === COMMA) {
        pushField()
        state = 'field-start'
      } else if (character === LF) {
        finishRow()
      } else if (character === CR) {
        state = 'maybe-newline-after-quote'
      } else {
        malformed = true
        onProblem({ kind: 'text-after-quote', row: index })
        state = 'in-field'
        append(character)
      }
    }
  }

  const end = () => {
    if (stopped) return
    if (state === 'in-quoted') {
      onProblem({ kind: 'unterminated-quote', row: index })
      malformed = true
    } else if (state === 'maybe-newline' || state === 'maybe-newline-after-quote') {
      append(CR)
    }
    if (pending || state === 'quote-in-quoted') finishRow()
  }

  return { push, end, stopped: () => stopped }
}

/**
 * Read a decoded text document through the reader in one go.
 *
 * Used by the tests and by the profiler's in-memory entry point; the streaming
 * entry point pushes chunks as they arrive.
 */
export function readCsvText(text, options) {
  const reader = createCsvReader(options)
  reader.push(text)
  reader.end()
  return reader
}
