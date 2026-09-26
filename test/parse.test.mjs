/**
 * The parse-failure helper.
 *
 * V8 reports a `JSON.parse` failure two ways and one of them quotes the input
 * back. Both documents this tool parses as JSON -- the configuration and the
 * baseline -- can hold values somebody would rather not see in a log, so the
 * helper is pinned here against the five shapes that have caught it out across
 * this catalog, and against a wording it has never seen.
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'

import { UNPARSEABLE, duplicateKeys, parseFailureDetail } from '../src/index.mjs'
import { EXAMPLES, csvText, runCli, withTempDir, writeText } from './helpers.mjs'

function failureFor(text) {
  try {
    JSON.parse(text)
    throw new Error('that document parsed')
  } catch (error) {
    return { message: error.message, detail: parseFailureDetail(error) }
  }
}

test('a document that literally reads "at position 1" is not sliced out of its own message', () => {
  const { message, detail } = failureFor('at position 1')
  // The trap: the phrase appears INSIDE the quoted span, so a helper that looks
  // for an offset before recognising the quoting shape returns the document.
  assert.ok(message.includes('"at position 1"'))
  assert.equal(detail, "unexpected token 'a' at the start of the document")
  assert.equal(detail.includes('at position 1'), false)
})

test('a document that is only a credential is not reproduced', () => {
  // A documentation example key, not a credential: it identifies nothing and
  // opens nothing.
  const { message, detail } = failureFor('AKIAIOSFODNN7EXAMPLE')
  assert.ok(message.includes('AKIAIOSFODNN7EXAMPLE'))
  assert.equal(detail, "unexpected token 'A' at the start of the document")
  assert.equal(detail.includes('AKIAIOSFODNN7EXAMPLE'), false)
})

test('a long document with a sensitive prefix leaks neither its start nor its middle', () => {
  const padding = 'x'.repeat(200)
  const document = `{"password": "hunter2-not-a-real-secret", "padding": "${padding}", "alpha": ZQXJVBMP7W}`
  const { message, detail } = failureFor(document)
  // V8 takes its window from the offence, not from the start, so "truncate the
  // front" would not have helped here.
  assert.ok(message.includes('...'))
  assert.ok(message.includes('ZQXJVBMP7W'))
  assert.equal(detail, "unexpected token 'Z' inside the document")
  assert.equal(detail.includes('ZQXJVBMP7W'), false)
  assert.equal(detail.includes('hunter2'), false)
})

test('a quoted span containing a newline is still recognised as a quoted span', () => {
  const { message, detail } = failureFor('token=abc\nsecret=xyz')
  assert.ok(message.includes('\n'))
  // Without the `s` flag the quoting branch silently fails to match, the helper
  // falls through to the backstop, and this exact sentence is lost. Equality is
  // the assertion that notices.
  assert.equal(detail, "unexpected token 'o' at the start of the document")
  assert.equal(detail.includes('secret=xyz'), false)
})

test('the safe positional form still yields a position', () => {
  const { message, detail } = failureFor('{"a": 1,}')
  assert.ok(message.startsWith('Expected double-quoted property name'))
  assert.equal(detail, 'Expected double-quoted property name in JSON at position 8 (line 1 column 9)')
})

test('an unterminated document keeps its own wording', () => {
  assert.equal(failureFor('{"a": ').detail, 'Unexpected end of JSON input')
})

test('a wording the helper has never been taught still cannot leak', () => {
  // The backstop does not depend on the branches above being right: across the
  // measured corpus of V8 parse messages, a message with no quoted snippet
  // carries no double quote at all, so a surviving double quote means a snippet
  // survived whatever the branches concluded.
  const invented = { message: 'Some future wording about "tok3n=s3cret-value" that nobody taught this helper' }
  assert.equal(parseFailureDetail(invented), UNPARSEABLE)
  assert.equal(parseFailureDetail(invented).includes('tok3n'), false)
})

test('a non-error, a missing message and an unconvertible one are all described safely', () => {
  assert.equal(parseFailureDetail(null), UNPARSEABLE)
  assert.equal(parseFailureDetail({}), UNPARSEABLE)
  assert.equal(parseFailureDetail({ message: { toString: {} } }), UNPARSEABLE)
})

test('an unparsable baseline is refused without being reproduced, with empty stdout', async () => {
  await withTempDir(async (directory) => {
    const csv = await writeText(directory, 'data.csv', csvText(['id'], [['R-1']]))
    const baseline = await writeText(directory, 'baseline.json', 'token=abc-not-a-real-secret')
    const result = await runCli(['--csv', csv, '--baseline', baseline, '--json'])
    assert.equal(result.code, 2)
    // A policy document: the run never had a subject, so nothing is reported.
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('abc-not-a-real-secret'), false)
    assert.ok(result.stderr.includes("unexpected token 'o' at the start of the document"))
  })
})

test('a key declared twice is found, wherever the braces and colons are', () => {
  // `JSON.parse` keeps the last of a repeated key and drops the rest in
  // silence, so the scanner has to see what the parser saw -- including that
  // `\u0061` and `a` are one key, and that a brace, a colon or a comma inside a
  // string is none of those things.
  const cases = [
    ['{"a":1,"a":2}', ['a']],
    ['{"a":1,"b":2}', []],
    ['{"a":{"x":1},"a":{"x":2}}', ['a']],
    ['{"a":{"x":1,"x":2}}', ['x']],
    // Two objects in an array are two objects, not one.
    ['{"a":[{"x":1},{"x":2}]}', []],
    // A key of the same name at a different depth is a different key.
    ['{"outer":{"a":1},"a":2}', []],
    ['{"a":1,"nested":{"a":1},"a":3}', ['a']],
    // Braces, colons, commas and quotes inside strings are data.
    ['{"a":"{\\"b\\":1,\\"b\\":2}"}', []],
    ['{"a:b":1,"a:b":2}', ['a:b']],
    ['{"a":"b,c","a":2}', ['a']],
    ['{"a":"}\\"","a":2}', ['a']],
    ['{"a\\\\":1,"a\\\\":2}', ['a\\']],
    // One key, two spellings: the parser unescapes, so this does too.
    ['{"\\u0061":1,"a":2}', ['a']],
    ['  {  "a" : 1 , "a" : 2 }  ', ['a']],
    ['{"a":1}', []],
    ['[]', []],
  ]
  for (const [text, expected] of cases) {
    JSON.parse(text)
    assert.deepEqual(duplicateKeys(text), expected, text)
  }
})

test('a policy document with a repeated key is refused, not silently halved', async () => {
  await withTempDir(async (directory) => {
    const csv = join(EXAMPLES, 'clean', 'orders.csv')

    // The baseline is the index every comparison is made against. Parsing this
    // one keeps only the second entry, so the run would compare against half
    // the policy its author wrote and then assert a positive verdict over it.
    const baseline = await writeText(directory, 'baseline.json',
      '{"schemaVersion":"1","columns":{"region":{"allowed":["north"]},"region":{"allowed":["south"]}}}')
    const baselineRun = await runCli(['--csv', csv, '--baseline', baseline, '--json'])
    assert.equal(baselineRun.code, 2)
    assert.equal(baselineRun.stdout, '')
    assert.ok(baselineRun.stderr.includes('repeats 1 key or keys inside one object'))
    assert.ok(baselineRun.stderr.includes('"region"'))

    const config = await writeText(directory, 'config.json', '{"schemaVersion":"1","minSample":4,"minSample":9}')
    const configRun = await runCli(['--csv', csv, '--config', config, '--json'])
    assert.equal(configRun.code, 2)
    assert.equal(configRun.stdout, '')
    assert.ok(configRun.stderr.includes('"minSample"'))

    // And a document with no repeated key is read exactly as before.
    const fine = await writeText(directory, 'fine.json', '{"schemaVersion":"1","minSample":4}')
    const fineRun = await runCli(['--csv', csv, '--config', fine, '--json'])
    assert.equal(fineRun.code, 0)
    assert.equal(JSON.parse(fineRun.stdout).configuration.minSample, 4)
  })
})
