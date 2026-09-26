/**
 * The boundary every untrusted string crosses.
 *
 * Stripping C0 and the two separators is not sanitising: four tools in this
 * catalog let the C1 range through, where U+0085 forges a line, and let the
 * bidi controls through, where U+202E reverses displayed text. Every class is
 * tested, and one of them arrives through a COLUMN HEADER rather than through
 * an excerpt -- a header is an identifier, and a tool that sanitises its
 * evidence carefully and prints an identifier raw has sanitised nothing.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  LINE_SEPARATORS,
  MAX_NAME_LENGTH,
  describeValue,
  hasUnsafeCharacter,
  isUsableName,
  renderReport,
  sanitize,
} from '../src/index.mjs'
import { columnNamed, csvText, profileText, ruleIds } from './helpers.mjs'

const CLASSES = Object.freeze([
  ['C0', String.fromCharCode(0x01)],
  ['C0 tab', String.fromCharCode(0x09)],
  ['C0 line feed', String.fromCharCode(0x0a)],
  ['C0 vertical tab', String.fromCharCode(0x0b)],
  ['C0 form feed', String.fromCharCode(0x0c)],
  ['C0 carriage return', String.fromCharCode(0x0d)],
  ['DEL', String.fromCharCode(0x7f)],
  ['C1 NEL', String.fromCharCode(0x85)],
  ['C1 CSI', String.fromCharCode(0x9b)],
  ['line separator', String.fromCharCode(0x2028)],
  ['paragraph separator', String.fromCharCode(0x2029)],
  ['bidi mark', String.fromCharCode(0x200e)],
  ['bidi override', String.fromCharCode(0x202e)],
  ['bidi isolate', String.fromCharCode(0x2066)],
])

const UNSAFE = new RegExp(`[\\p{Cc}\\p{Cf}${LINE_SEPARATORS}]`, 'u')

/**
 * The three classes a VALUE may legally carry: they are layout, and collapsing
 * them to a space prints the value faithfully. RFC 4180 section 2.6 permits a
 * line break inside a quoted field, and a tab is ordinary text. Everything else
 * in the table hides or reorders text and still makes a value unprintable.
 *
 * A header is an identity and forgives none of them: two names printing the same
 * text would silently become one column.
 *
 * The vertical tab and the form feed sit between the three in the C0 block and
 * are NOT layout: a delimited export does not emit either one to lay a value
 * out. They are in the table so that the line between the two sets is drawn by a
 * test rather than by a sentence.
 */
const LAYOUT = new Set(['C0 tab', 'C0 line feed', 'C0 carriage return'])

test('every unsafe class is removed from a sanitised string', () => {
  for (const [name, character] of CLASSES) {
    const cleaned = sanitize(`before${character}after`)
    assert.equal(UNSAFE.test(cleaned), false, name)
    assert.equal(cleaned, 'before after', name)
    assert.equal(hasUnsafeCharacter(`before${character}after`), true, name)
  }
  assert.equal(hasUnsafeCharacter('ordinary text'), false)
})

test('a string of nothing but unsafe characters is not a usable name', () => {
  for (const [name, character] of CLASSES) {
    assert.equal(sanitize(character.repeat(4)), '', name)
    // `value.trim().length > 0` is true for most of these, which is exactly the
    // gap that shipped as a bug: the question has to be asked of the RENDERED
    // form.
    assert.equal(isUsableName(character.repeat(4)), false, name)
  }
})

test('a name that merely survives sanitising is still refused, because it would collide', () => {
  const forged = `a${String.fromCharCode(0x01)}b`
  assert.equal(sanitize(forged), 'a b')
  assert.equal(isUsableName(forged), false)
  assert.equal(isUsableName('a b'), true)
  assert.equal(isUsableName('a'.repeat(MAX_NAME_LENGTH)), true)
  assert.equal(isUsableName('a'.repeat(MAX_NAME_LENGTH + 1)), false)
  assert.equal(isUsableName(''), false)
})

test('an unsafe character arriving through a COLUMN HEADER stops the run rather than printing', async () => {
  for (const [name, character] of CLASSES) {
    // A bare line feed would end the header row instead of landing inside a
    // name, so it arrives the way a file would really carry one: quoted.
    const header = character === '\n' ? 'id,"a\nb"' : `id,a${character}b`
    const report = await profileText(`${header}\n1,2\n`)
    assert.deepEqual(ruleIds(report), ['header-column-unusable'], name)
    assert.equal(UNSAFE.test(JSON.stringify(report)), false, name)
    assert.equal(report.status, 'incomplete', name)
  }
})

test('an unsafe character arriving through a VALUE is counted, never printed', async () => {
  for (const [name, character] of CLASSES) {
    const document = character === '\n'
      ? 'id,note\nR-1,"x\ny"\n'
      : csvText(['id', 'note'], [['R-1', `x${character}y`]])
    const report = await profileText(document)
    // Whatever the class, the character itself never reaches the output.
    assert.equal(UNSAFE.test(JSON.stringify(report)), false, name)
    const note = columnNamed(report, 'note')
    if (LAYOUT.has(name)) {
      // Layout: the value is examined and printed with its whitespace
      // collapsed, and the difference is counted rather than hidden.
      assert.equal(note.values.unprintable, 0, name)
      assert.equal(note.values.examined, 1, name)
      assert.equal(note.values.reshaped, 1, name)
      assert.equal(ruleIds(report).includes('value-unprintable'), false, name)
    } else {
      assert.equal(note.values.unprintable, 1, name)
      assert.equal(note.values.reshaped, 0, name)
      assert.ok(ruleIds(report).includes('value-unprintable'), name)
    }
  }
})

test('a value that cannot be converted to a primitive is described, never thrown over', () => {
  // `{"id": {"toString": {}}}` parses into exactly this, and `String(value)`
  // throws "Cannot convert object to primitive value" on it. A baseline is JSON
  // this tool did not write.
  const hostile = { toString: {} }
  assert.throws(() => `${hostile}`, TypeError)
  assert.equal(describeValue(hostile), '[object]')
  assert.equal(sanitize(hostile), '[object]')
  assert.equal(describeValue([1, 2]), '[array]')
  assert.equal(describeValue(null), 'null')
  assert.equal(hasUnsafeCharacter(hostile), true)
})

test('the two separators are escaped on the way out as well as refused on the way in', () => {
  // Belt and braces: nothing upstream can put one here any more, which is
  // precisely why it is the kind of guarantee that quietly stops being true.
  const forged = {
    schemaVersion: '1',
    tool: 'csv-anomaly-profiler',
    status: 'pass',
    summary: {},
    columns: [{ name: `a${String.fromCharCode(0x2028)}b` }],
    findings: [],
  }
  const rendered = renderReport(forged)
  assert.equal(rendered.includes(String.fromCharCode(0x2028)), false)
  assert.ok(rendered.includes('a\\u2028b'))
  assert.equal(JSON.parse(rendered).columns[0].name, `a${String.fromCharCode(0x2028)}b`)
})

test('sanitising bounds the length and marks what it cut', () => {
  assert.equal(sanitize('x'.repeat(200)), 'x'.repeat(200))
  assert.equal(sanitize('x'.repeat(201)), `${'x'.repeat(197)}...`)
})
