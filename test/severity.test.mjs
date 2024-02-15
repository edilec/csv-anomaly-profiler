/**
 * Severity, pinned behaviourally.
 *
 * A severity table asserted against a hand-written expected map in the tests is
 * three declarations agreeing with each other, and a coordinated edit of all
 * three passes. Severity decides the EXIT CODE, so the exit code is what these
 * tests assert.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  UNSETTLED_RULES,
  makeFinding,
  marksUnsettled,
  msg,
  severityFor,
  statusFor,
} from '../src/index.mjs'
import { csvText, runCli, withTempDir, writeJson, writeText } from './helpers.mjs'

const STEADY = [50, 51, 49, 52, 48, 50, 53, 47, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49]

function readings(values) {
  return csvText(['sample_id', 'reading'], values.map((value, index) => [`S-${index + 1}`, value]))
}

async function runOn(text, { config = null, baseline = null } = {}) {
  return withTempDir(async (directory) => {
    const csv = await writeText(directory, 'data.csv', text)
    const args = ['--csv', csv, '--json']
    if (config !== null) args.push('--config', await writeJson(directory, 'config.json', { schemaVersion: '1', ...config }))
    if (baseline !== null) args.push('--baseline', await writeJson(directory, 'baseline.json', { schemaVersion: '1', ...baseline }))
    const result = await runCli(args)
    return { result, report: result.stdout === '' ? null : JSON.parse(result.stdout) }
  })
}

test('an error finding is exit 1, and that is what "error" means here', async () => {
  const values = [...STEADY]
  values[13] = 500
  const { result, report } = await runOn(readings(values))
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['numeric-outlier'])
  assert.equal(report.findings[0].severity, 'error')
  assert.equal(report.status, 'fail')
  assert.equal(result.code, 1)
})

test('an info finding is information, not a gap: it leaves the status to the other findings', async () => {
  // Three values outside the fence and a listing capped at two. The COUNT is
  // complete, so nothing about the evidence is missing: the shortened listing
  // must not turn the run incomplete, and the outliers beside it must still
  // fail it.
  const values = [...STEADY]
  values[3] = 400
  values[7] = 500
  values[13] = 600
  const { result, report } = await runOn(readings(values), { config: { maxExamples: 2 } })
  const kinds = report.findings.map((finding) => finding.ruleId)
  assert.deepEqual(kinds.filter((kind) => kind === 'examples-limited'), ['examples-limited'])
  assert.equal(report.findings.find((finding) => finding.ruleId === 'examples-limited').severity, 'info')
  assert.equal(report.status, 'fail')
  assert.equal(result.code, 1)
  // And on its own it is a pass: this is the only rule in the catalog that
  // reports a shortened listing without reporting a shortened count.
  assert.equal(statusFor([{ ruleId: 'examples-limited', severity: 'info' }]), 'pass')
})

test('a warning that leaves a question open is exit 2, not exit 0', async () => {
  const { result, report } = await runOn(readings([1, 2, 3]))
  assert.deepEqual(report.findings.map((finding) => finding.ruleId), ['sample-too-small'])
  assert.equal(report.findings[0].severity, 'warning')
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})

test('missing evidence outranks a policy failure', () => {
  const findings = [
    { ruleId: 'numeric-outlier', severity: 'error' },
    { ruleId: 'sample-too-small', severity: 'warning' },
  ]
  assert.equal(statusFor(findings), 'incomplete')
  assert.equal(statusFor([findings[0]]), 'fail')
  assert.equal(statusFor([]), 'pass')
})

test('a file with both an outlier and a refusal exits 2, not 1', async () => {
  const values = [...STEADY]
  values[13] = 500
  // A short row that cannot be aligned to the header sits beside a value the
  // fence rejects: the outlier is a policy failure and the short row is a gap,
  // and a gap outranks a failure.
  const text = `${readings(values)}S-21\n`
  const { result, report } = await runOn(text)
  const kinds = report.findings.map((finding) => finding.ruleId)
  assert.deepEqual(kinds, ['numeric-outlier', 'row-field-count-mismatch'])
  assert.equal(report.status, 'incomplete')
  assert.equal(result.code, 2)
})

test('the severity table is the only place a severity is written down', () => {
  assert.deepEqual([...RULE_IDS].sort(), Object.keys(RULE_SEVERITY).sort())
  for (const ruleId of RULE_IDS) assert.ok(SEVERITIES.includes(severityFor(ruleId)), ruleId)
  assert.throws(() => severityFor('no-such-rule'), /Unknown ruleId/u)
  assert.throws(() => marksUnsettled('no-such-rule'), /Unknown ruleId/u)
  for (const ruleId of UNSETTLED_RULES) {
    assert.ok(RULE_IDS.includes(ruleId), ruleId)
    assert.equal(marksUnsettled(ruleId), true, ruleId)
  }
  // The five positive findings are deliberately NOT unsettled: each is a
  // statement about evidence the run did obtain.
  for (const ruleId of ['numeric-outlier', 'unexpected-category', 'missingness-above-threshold', 'missingness-drift', 'category-drift']) {
    assert.equal(marksUnsettled(ruleId), false, ruleId)
  }
})

test('a finding cannot be built with a raw string, and cannot be built for an unknown rule', () => {
  assert.throws(
    () => makeFinding('no-rows-profiled', 'a bare string', {}),
    /must build its message with the msg tagged template/u,
  )
  assert.throws(() => makeFinding('invented-rule', msg`text`, {}), /Unknown ruleId/u)
})

test('this tool refuses to write a sentence that claims more than a dispersion test supports', () => {
  assert.throws(() => msg`This difference is statistically significant.`, /may not claim more than a robust dispersion test/u)
  assert.throws(() => msg`The root cause is the upstream job.`, /may not claim more than a robust dispersion test/u)
  assert.throws(() => msg`This value is wrong.`, /may not claim more than a robust dispersion test/u)
  // The scan looks at what this tool WROTE, never at what it READ: a file whose
  // column is literally named `root_cause` is data, and must not stop the run.
  const built = msg`The column ${'root_cause'} was profiled.`
  assert.equal(built.text, 'The column root_cause was profiled.')
})

test('a column literally named for a forbidden phrase is profiled, not refused', async () => {
  const { result, report } = await runOn(csvText(['root cause', 'p-value'], [['a', 'b'], ['c', 'd']]))
  assert.deepEqual(report.columns.map((column) => column.name), ['p-value', 'root cause'])
  assert.equal(result.code, 0)
})
