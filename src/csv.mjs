/**
 * A streaming delimited-text reader.
 *
 * It holds one field and one row at a time, both bounded, so the memory a run
 * needs does not grow with the size of the file. A value longer than the field
 * bound stops being accumulated and is marked truncated rather than kept, which
 * is the difference between a bound and a hope.
 *
 * Three decisions about input RFC 4180 does not describe, written down because
 * each one is a place a reader could invent something. Two of them are
 * DEVIATIONS from the specification, said plainly rather than dressed up as
 * what the grammar meant:
 *
 * 1. `ab"cd`. RFC 4180 does not permit this: its `non-escaped` production
 *    excludes DQUOTE, so a strict reader refuses the row. This one keeps the
 *    quote as a literal character, because there is only one reading available
 *    -- the field did not open with a quote, so no quote inside it can be
 *    closing one -- and refusing would report a defect on a file that carries
 *    exactly the data it appears to carry.
 * 2. `"ab"c`. Here the grammar really does run out: after a closing DQUOTE only
 *    a COMMA or a line ending may follow, and the two readings of `c` differ in
 *    what the data IS. The row is reported as malformed and is not profiled.
 * 3. A lone CR. RFC 4180 excludes CR from `non-escaped` too, so this is the
 *    second deviation: it is kept as data rather than treated as a record
 *    separator, because treating it as one would split a row on a character
 *    that may well be inside a value. The value is then reported later as one
 *    that does not print as it is stored, so it is never silently profiled.
 *
 * Both deviations are in the README, under the shapes this reader accepts.
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
 * `onRow` receives `{ index, fields, fieldCount, malformed, blank }` where
 * `fields` is an array of `{ text, truncated }` capped at `maxColumns` entries
 * and `fieldCount` is how many fields the row actually had. Returning `false`
 * from `onRow` stops the reader: the caller owns the row bound, because only the
 * caller knows what it means.
 *
 * `blank` marks a line that held no character at all before its ending. It is
 * not the same as a line holding one empty field: `""` is a row whose single
 * value is the empty string, and a reader that could not tell the two apart
 * would silently drop it. Only the reader knows which of the two arrived, so
 * only the reader can say.
 */
export function createCsvReader({ maxFieldLength, maxColumns, onRow, onProblem }) {
  let state = 'field-start'
  let field = ''
  let truncated = false
  let fields = []
  let fieldCount = 0
  let malformed = false
  let quoted = false
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
    const blank = !quoted && !malformed && fieldCount === 1 && fields[0]?.text === ''
    const row = { index, fields, fieldCount, malformed, blank }
    index += 1
    fields = []
    fieldCount = 0
    malformed = false
    quoted = false
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
          quoted = true
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
        // A lone CR: kept as data. See the deviation note at the top.
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
