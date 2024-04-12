/**
 * The reader, and the three places it could have invented something.
 *
 * Each ambiguous shape below has one reading this tool takes and one it
 * refuses, and the refusals are what keep a malformed file from being profiled
 * as though it had been understood.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { CSV_PROBLEMS, createCsvReader, readCsvText } from '../src/index.mjs'
import { columnNamed, profileText } from './helpers.mjs'

function parse(text, { maxFieldLength = 64, maxColumns = 8 } = {}) {
  const rows = []
  const problems = []
  readCsvText(text, {
    maxFieldLength,
    maxColumns,
    onRow: (row) => { rows.push(row) },
    onProblem: (problem) => problems.push(problem),
  })
  return {
    rows: rows.map((row) => ({
      index: row.index,
      count: row.fieldCount,
      malformed: row.malformed,
      fields: row.fields.map((field) => field.text),
      truncated: row.fields.map((field) => field.truncated),
    })),
    problems,
  }
}

test('the ordinary shapes', () => {
  assert.deepEqual(parse('a,b\n1,2\n').rows.map((row) => row.fields), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parse('a,b\n1,2').rows.map((row) => row.fields), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parse('a,b\r\n1,2\r\n').rows.map((row) => row.fields), [['a', 'b'], ['1', '2']])
  assert.deepEqual(parse('a,b\n"x,y",2\n').rows[1].fields, ['x,y', '2'])
  assert.deepEqual(parse('a\n"say ""hi"""\n').rows[1].fields, ['say "hi"'])
  assert.deepEqual(parse('a,b\n"line1\nline2",2\n').rows[1].fields, ['line1\nline2', '2'])
  assert.deepEqual(parse('﻿a,b\n1,2\n').rows[0].fields, ['a', 'b'])
  assert.deepEqual(parse('').rows, [])
})

test('a quoted line break is ordinary all the way through, not only in the reader', async () => {
  // The reader parsing it is half a sentence. Listing the shape among the
  // ORDINARY ones and leaving the other half unasserted is how it came to be
  // counted `value-unprintable`, never examined, and exit 2 -- for the one
  // thing RFC 4180 quoting exists for. The neighbouring test for the lone
  // carriage return pins both halves; so does this one.
  assert.deepEqual(parse('a,b\n"line1\nline2",2\n').rows[1].fields, ['line1\nline2', '2'])

  const report = await profileText('id,note\nR-1,"line1\nline2"\nR-2,plain\n')
  const note = columnNamed(report, 'note')
  assert.equal(note.values.unprintable, 0)
  assert.equal(note.values.examined, 2)
  assert.equal(note.values.reshaped, 1)
  assert.deepEqual(report.findings, [])
  assert.equal(report.status, 'pass')
})

test('a trailing newline does not invent a final empty row, and a blank line is one empty field', () => {
  assert.equal(parse('a\n1\n').rows.length, 2)
  assert.equal(parse('a\n1\n\n').rows.length, 3)
  assert.deepEqual(parse('a\n1\n\n').rows[2].fields, [''])
  assert.equal(parse('a\n1\n\n').rows[2].count, 1)
})

test('a quote inside an unquoted field is kept as data: a documented deviation, not a reading of the grammar', () => {
  // RFC 4180 does NOT permit this -- its `non-escaped` production excludes
  // DQUOTE -- so a strict reader would refuse the row. This reader accepts it,
  // because the field did not open with a quote and so no quote inside it can
  // be closing one: there is only one reading of the data available.
  const parsed = parse('a\nab"cd\n')
  assert.deepEqual(parsed.rows[1].fields, ['ab"cd'])
  assert.equal(parsed.rows[1].malformed, false)
  assert.deepEqual(parsed.problems, [])
})

test('text after a closing quote has no reading, so the row is refused rather than guessed at', () => {
  const parsed = parse('a\n"ab"c\n')
  assert.equal(parsed.rows[1].malformed, true)
  assert.deepEqual(parsed.problems, [{ kind: 'text-after-quote', row: 1 }])
  assert.ok(CSV_PROBLEMS.includes('text-after-quote'))
})

test('a quote left open at the end of the file is reported, not silently closed', () => {
  const parsed = parse('a\n"ab')
  assert.deepEqual(parsed.problems, [{ kind: 'unterminated-quote', row: 1 }])
  assert.equal(parsed.rows[1].malformed, true)
})

test('a lone carriage return is kept as data, and the value is then printed with it collapsed', async () => {
  // The second deviation from RFC 4180, which excludes CR from `non-escaped`
  // as well. Keeping it costs nothing because a carriage return is layout: the
  // value is examined and printed with its whitespace collapsed, and the
  // difference is counted rather than hidden.
  const parsed = parse('a\nx\ry\n')
  assert.equal(parsed.rows.length, 2)
  assert.deepEqual(parsed.rows[1].fields, ['x\ry'])
  assert.equal(parsed.rows[1].malformed, false)

  // The second half of the sentence, which the reader alone does not show.
  const report = await profileText('id,note\nR-1,x\ry\nR-2,plain\n')
  assert.equal(columnNamed(report, 'note').values.unprintable, 0)
  assert.equal(columnNamed(report, 'note').values.examined, 2)
  assert.equal(columnNamed(report, 'note').values.reshaped, 1)
  assert.equal(report.findings.some((finding) => finding.ruleId === 'value-unprintable'), false)
  // The character itself never reaches the output.
  assert.equal(JSON.stringify(report).includes('\\r'), false)
  assert.equal(report.status, 'pass')
})

test('a field longer than the bound stops being accumulated and is marked, not kept', () => {
  const atLimit = parse(`a\n${'x'.repeat(8)}\n`, { maxFieldLength: 8 })
  assert.equal(atLimit.rows[1].fields[0].length, 8)
  assert.deepEqual(atLimit.rows[1].truncated, [false])

  const overLimit = parse(`a\n${'x'.repeat(9)}\n`, { maxFieldLength: 8 })
  assert.equal(overLimit.rows[1].fields[0].length, 8)
  assert.deepEqual(overLimit.rows[1].truncated, [true])
})

test('the reader stores at most the column bound and still counts what it saw', () => {
  const parsed = parse('a,b,c,d\n1,2,3,4\n', { maxColumns: 2 })
  assert.equal(parsed.rows[0].fields.length, 2)
  assert.equal(parsed.rows[0].count, 4)
})

test('a row count is reported to the caller, which owns the bound', () => {
  const rows = []
  readCsvText('a\n1\n2\n3\n', {
    maxFieldLength: 64,
    maxColumns: 4,
    onRow: (row) => {
      rows.push(row.index)
      return rows.length < 3
    },
    onProblem: () => {},
  })
  assert.deepEqual(rows, [0, 1, 2])
})

test('the same document split across chunk boundaries parses identically', () => {
  const document = 'a,b\n"x,\ny",2\r\n3,4\n'
  const whole = parse(document).rows.map((row) => row.fields)
  // The split is taken at every offset, including inside a quoted field, inside
  // a doubled quote and between the CR and the LF. A reader that kept any of
  // its state in a local of `push` would fail one of these.
  for (let cut = 1; cut < document.length; cut += 1) {
    const streamed = []
    const reader = createCsvReader({
      maxFieldLength: 64,
      maxColumns: 8,
      onRow: (row) => { streamed.push(row.fields.map((field) => field.text)) },
      onProblem: () => {},
    })
    reader.push(document.slice(0, cut))
    reader.push(document.slice(cut))
    reader.end()
    assert.deepEqual(streamed, whole, `split at ${cut}`)
  }
})

test('a quoted header is read, and an empty header cell is refused', async () => {
  const quoted = await profileText('"id","region"\nR-1,north\n')
  assert.deepEqual(quoted.columns.map((column) => column.name), ['id', 'region'])

  const trailing = await profileText('id,region,\nR-1,north,x\n')
  assert.deepEqual(trailing.findings.map((finding) => finding.ruleId), ['header-column-unusable'])
  assert.deepEqual(trailing.columns, [])
  assert.equal(trailing.status, 'incomplete')
})

test('a data row with more fields than the header is refused, not trimmed to fit', async () => {
  const report = await profileText('id,region\nR-1,north\nR-2,north,extra\n')
  assert.equal(report.summary.rowsProfiled, 1)
  assert.equal(columnNamed(report, 'region').values.total, 1)
  assert.ok(report.findings.some((finding) => finding.ruleId === 'row-field-count-mismatch'))
  assert.equal(report.status, 'incomplete')
})

test('a padded header is accepted and two headers that differ only by padding collide', async () => {
  // `id, region` is an ordinary export and RFC 4180 keeps the space in the
  // value, so refusing it would report a defect on a file nothing is wrong
  // with. The padding is dropped from the identity and from nothing else.
  const padded = await profileText('id, region\nR-1, north\n')
  assert.deepEqual(padded.columns.map((column) => column.name), ['id', 'region'])
  // The value is examined, and it is compared and printed with its whitespace
  // collapsed -- which is what keeps the same padded export from failing its own
  // baseline one level down. test/false-positives.test.mjs drives that case.
  assert.equal(columnNamed(padded, 'region').values.examined, 1)
  assert.equal(columnNamed(padded, 'region').type, 'categorical')

  // Which is exactly why dropping it is safe: the two names collapse onto one
  // and the duplicate check catches them.
  const collide = await profileText('id,id \nR-1,x\n')
  assert.deepEqual(collide.findings.map((finding) => finding.ruleId), ['duplicate-column'])
  assert.deepEqual(collide.columns, [])

  // Nothing else is forgiven: a control character, an empty name and an
  // over-long name are still refused.
  for (const header of [`id,a${String.fromCharCode(1)}b`, 'id, ', `id,${'x'.repeat(129)}`]) {
    const refused = await profileText(`${header}\nR-1,x\n`)
    assert.deepEqual(refused.findings.map((finding) => finding.ruleId), ['header-column-unusable'], header)
  }
})
