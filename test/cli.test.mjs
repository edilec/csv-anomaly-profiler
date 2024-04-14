/**
 * The command-line surface, including the two shapes of exit 2.
 *
 * A configuration or baseline error means the run never had a subject, so
 * stdout stays EMPTY and the message goes to stderr. Unreadable evidence means
 * the run had a subject and failed to obtain evidence about it, so stdout
 * carries an `incomplete` report naming what was not profiled. A consumer that
 * pipes stdout has to handle both, which is why both are pinned.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'

import { BIN, EXAMPLES, ROOT, runCli, withTempDir, writeJson, writeText } from './helpers.mjs'

const CLEAN = join(EXAMPLES, 'clean', 'orders.csv')
const CLEAN_BASELINE = join(EXAMPLES, 'clean', 'baseline.json')
const ANOMALOUS = join(EXAMPLES, 'anomalous', 'orders.csv')
const ANOMALOUS_BASELINE = join(EXAMPLES, 'anomalous', 'baseline.json')
const INCOMPLETE = join(EXAMPLES, 'incomplete', 'readings.csv')

test('--help prints the help on stderr, leaves stdout empty and exits 0', async () => {
  for (const flag of ['--help', '-h']) {
    const result = await runCli([flag])
    assert.equal(result.code, 0, flag)
    assert.equal(result.stdout, '', flag)
    assert.ok(result.stderr.includes('Usage:'), flag)
    assert.ok(result.stderr.includes('Exit codes:'), flag)
  }
})

test('the help states the refusals and the two shapes of exit 2', async () => {
  const { stderr } = await runCli(['--help'])
  assert.ok(stderr.includes('stdout stays EMPTY'))
  assert.ok(stderr.includes('A refusal is a result'))
  assert.ok(stderr.includes('writes no file'))
  assert.ok(stderr.includes('reads no clock'))
})

test('an unknown option is a configuration error: empty stdout, message on stderr, exit 2', async () => {
  const result = await runCli(['--csv', CLEAN, '--wat'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('Unknown option "--wat"'))
})

test('an option value carrying a control character cannot forge a line in the diagnostic', async () => {
  const forged = `--x${String.fromCharCode(0x0a)}Unknown option "--y"`
  const result = await runCli(['--csv', CLEAN, forged])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('Unknown option "--x Unknown option "--y""'))
})

test('a missing --csv, and an option with no value, are both configuration errors', async () => {
  const missing = await runCli([])
  assert.equal(missing.code, 2)
  assert.equal(missing.stdout, '')
  assert.ok(missing.stderr.includes('--csv is required'))

  const empty = await runCli(['--csv'])
  assert.equal(empty.code, 2)
  assert.equal(empty.stdout, '')
  assert.ok(empty.stderr.includes('--csv requires a value'))
})

test('an unknown configuration key is refused rather than ignored', async () => {
  await withTempDir(async (directory) => {
    const config = await writeJson(directory, 'config.json', { schemaVersion: '1', minSampel: 4 })
    const result = await runCli(['--csv', CLEAN, '--config', config])
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    // A one-character typo must not turn a real failure into a green run.
    assert.ok(result.stderr.includes('Unknown configuration key "minSampel"'))
  })
})

test('an unknown baseline key, and a distribution that does not sum to one, are refused', async () => {
  await withTempDir(async (directory) => {
    const stray = await writeJson(directory, 'b1.json', {
      schemaVersion: '1',
      columns: { region: { allowedd: ['north'] } },
    })
    const strayRun = await runCli(['--csv', CLEAN, '--baseline', stray])
    assert.equal(strayRun.code, 2)
    assert.equal(strayRun.stdout, '')
    assert.ok(strayRun.stderr.includes('Unknown baseline key "allowedd"'))

    const skewed = await writeJson(directory, 'b2.json', {
      schemaVersion: '1',
      columns: { region: { categories: { north: 0.5, south: 0.2 } } },
    })
    const skewedRun = await runCli(['--csv', CLEAN, '--baseline', skewed])
    assert.equal(skewedRun.code, 2)
    assert.equal(skewedRun.stdout, '')
    assert.ok(skewedRun.stderr.includes('a distribution must sum to 1'))
  })
})

test('a baseline that lists one value twice is refused, however long the list is', async () => {
  await withTempDir(async (directory) => {
    const twice = await writeJson(directory, 'b3.json', {
      schemaVersion: '1',
      columns: { region: { allowed: ['north', 'south', 'north'] } },
    })
    const twiceRun = await runCli(['--csv', CLEAN, '--baseline', twice])
    assert.equal(twiceRun.code, 2)
    assert.equal(twiceRun.stdout, '')
    assert.ok(twiceRun.stderr.includes('lists "north" twice'))

    // The check is a set rather than a scan of the list so far, so it has to
    // still refuse a duplicate at the far end of a long list.
    const many = Array.from({ length: 500 }, (_, index) => `v${index}`)
    const far = await writeJson(directory, 'b4.json', {
      schemaVersion: '1',
      columns: { region: { allowed: [...many, many[0]] } },
    })
    const farRun = await runCli(['--csv', CLEAN, '--baseline', far])
    assert.equal(farRun.code, 2)
    assert.equal(farRun.stdout, '')
    assert.ok(farRun.stderr.includes('lists "v0" twice'))
  })
})

test('--method is validated the same way the document is', async () => {
  const result = await runCli(['--csv', CLEAN, '--method', 'zscore'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.ok(result.stderr.includes('must be one of mad, iqr'))
})

test('--method overrides the configuration, and the report says which ran', async () => {
  await withTempDir(async (directory) => {
    const config = await writeJson(directory, 'config.json', { schemaVersion: '1', method: 'mad' })
    const result = await runCli(['--csv', CLEAN, '--config', config, '--method', 'iqr', '--json'])
    assert.equal(JSON.parse(result.stdout).configuration.method, 'iqr')
  })
})

test('an unreadable file is the OTHER shape of exit 2: a report on stdout', async () => {
  const result = await runCli(['--csv', join(EXAMPLES, 'no-such-file.csv'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['csv-unreadable'])
  assert.equal(report.findings[0].location.file, 'no-such-file.csv')
})

test('a file whose bytes are not UTF-8 is reported as undecodable, never guessed at', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'latin.csv')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from([0x69, 0x64, 0x0a, 0xff, 0xfe, 0x0a]))
    const result = await runCli(['--csv', path, '--json'])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['csv-not-utf8'])
    assert.equal(report.status, 'incomplete')
  })
})

test('the human summary goes to stderr by default and is suppressed by --json', async () => {
  const noisy = await runCli(['--csv', CLEAN, '--baseline', CLEAN_BASELINE])
  assert.equal(noisy.code, 0)
  assert.ok(noisy.stderr.includes('Status pass.'))
  assert.ok(noisy.stderr.includes('column(s) over'))
  JSON.parse(noisy.stdout)

  const quiet = await runCli(['--csv', CLEAN, '--baseline', CLEAN_BASELINE, '--json'])
  assert.equal(quiet.stderr, '')
  assert.equal(quiet.stdout, noisy.stdout)
})

test('the shipped examples run, and each ends where its name says it does', async () => {
  const clean = await runCli(['--csv', CLEAN, '--baseline', CLEAN_BASELINE, '--json'])
  assert.equal(clean.code, 0)
  assert.equal(JSON.parse(clean.stdout).status, 'pass')
  assert.deepEqual(JSON.parse(clean.stdout).findings, [])

  const anomalous = await runCli(['--csv', ANOMALOUS, '--baseline', ANOMALOUS_BASELINE, '--json'])
  assert.equal(anomalous.code, 1)
  const found = JSON.parse(anomalous.stdout)
  assert.equal(found.status, 'fail')
  assert.deepEqual(found.findings.map((finding) => finding.ruleId).sort(), [
    'missingness-above-threshold', 'missingness-drift', 'numeric-outlier', 'unexpected-category',
  ])

  const partial = await runCli(['--csv', INCOMPLETE, '--json'])
  assert.equal(partial.code, 2)
  const report = JSON.parse(partial.stdout)
  assert.equal(report.status, 'incomplete')
  assert.deepEqual(report.findings.map((finding) => finding.ruleId).sort(), [
    'column-mixed-types', 'sample-too-small',
  ])
})

test('a file path is never echoed back as an absolute host path', async () => {
  const result = await runCli(['--csv', CLEAN, '--baseline', CLEAN_BASELINE, '--json'])
  const report = JSON.parse(result.stdout)
  assert.equal(report.source.file, 'orders.csv')
  assert.equal(report.source.baseline, 'baseline.json')
  assert.equal(result.stdout.includes(EXAMPLES), false)
})

test('a consumer that stops reading gets one line, not a stack trace carrying this file path', async () => {
  // `--json | head` closes the pipe while the report is still going down it.
  // With nothing listening for the EPIPE, Node threw it as an unhandled error
  // event: a stack trace on stderr carrying the ABSOLUTE path of the binary,
  // a truncated document on stdout, and exit 1 as though a threshold had
  // failed. The contract forbids an absolute host path in the report, and a
  // crash trace is the same leak through another door.
  const { code, stderr } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, '--csv', CLEAN, '--baseline', CLEAN_BASELINE, '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.destroy()
    let collected = ''
    child.stderr.on('data', (chunk) => { collected += chunk })
    child.on('close', (exit) => resolve({ code: exit, stderr: collected }))
  })

  // A report that did not arrive is an execution failure, not a verdict.
  assert.equal(code, 2)
  assert.equal(stderr, 'The report was not written to stdout: EPIPE.\n')
  assert.equal(stderr.includes(ROOT), false)
  assert.equal(stderr.includes('    at '), false)
})

test('a directory given where a file belongs is refused, not read', async () => {
  const result = await runCli(['--csv', EXAMPLES, '--json'])
  assert.equal(result.code, 2)
  assert.deepEqual(JSON.parse(result.stdout).findings.map((finding) => finding.ruleId), ['csv-unreadable'])

  await withTempDir(async (directory) => {
    const csv = await writeText(directory, 'data.csv', 'id\n1\n')
    const asConfig = await runCli(['--csv', csv, '--config', directory])
    assert.equal(asConfig.code, 2)
    assert.equal(asConfig.stdout, '')
    assert.ok(asConfig.stderr.includes('not a regular file'))
  })
})
