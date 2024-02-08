/**
 * The report envelope, and the documents that describe it.
 *
 * The contract says stdout carries the JSON report and nothing else, that
 * findings are ordered deterministically, and that `location.file` is never an
 * absolute host path. Those are checked against real output rather than against
 * a description of it. The README is checked against the code in both
 * directions, because a documentation overclaim is a defect here.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import {
  CATALOG,
  COLUMN_TYPES,
  RULE_IDS,
  SEVERITIES,
  TOOL_ID,
  compareFindings,
  renderReport,
} from '../src/index.mjs'
import { EXAMPLES, ROOT, csvText, profileText, runCli } from './helpers.mjs'

const REPORT_KEYS = [
  'schemaVersion', 'tool', 'status', 'summary', 'configuration', 'source',
  'columns', 'findings', 'disclaimer', 'notEstablished',
]

const STEADY = [50, 51, 49, 52, 48, 50, 53, 47, 51, 49, 50, 52, 48, 51, 49, 50, 52, 48, 51, 49]

async function everyReport() {
  const planted = [...STEADY]
  planted[13] = 500
  return Promise.all([
    profileText(csvText(['id', 'reading'], STEADY.map((value, index) => [`S-${index}`, value]))),
    profileText(csvText(['id', 'reading'], planted.map((value, index) => [`S-${index}`, value]))),
    profileText('id,region\n'),
    profileText('id,region\nR-1,north\nR-2\n'),
    profileText(csvText(['id', 'region'], [['R-1', 'north'], ['R-2', 'south']]), {
      baseline: { columns: { id: {}, region: { allowed: ['north'], missingRate: 0, categories: { north: 1 } } } },
    }),
  ])
}

test('the envelope is the shape the contract describes, in every outcome', async () => {
  for (const report of await everyReport()) {
    assert.deepEqual(Object.keys(report), REPORT_KEYS)
    assert.equal(report.schemaVersion, '1')
    assert.equal(report.tool, TOOL_ID)
    assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
    for (const [key, value] of Object.entries(report.summary)) {
      assert.ok(Number.isInteger(value), `summary.${key} must be a whole number`)
    }
    assert.ok(Array.isArray(report.findings))
    assert.ok(Array.isArray(report.columns))
  }
})

test('every finding carries a known rule, a known severity and a relative location', async () => {
  for (const report of await everyReport()) {
    for (const finding of report.findings) {
      assert.ok(RULE_IDS.includes(finding.ruleId), finding.ruleId)
      assert.ok(SEVERITIES.includes(finding.severity), finding.severity)
      assert.ok(finding.message.length > 0)
      assert.equal(finding.location.file, 'data.csv')
      assert.equal(finding.location.file.startsWith('/'), false)
      if (finding.location.pointer !== undefined) assert.ok(finding.location.pointer.startsWith('/'))
      assert.deepEqual(
        Object.keys(finding).filter((key) => !['ruleId', 'severity', 'message', 'location', 'evidence', 'suggestion'].includes(key)),
        [],
      )
    }
  }
})

test('findings come out already sorted by the documented key', async () => {
  for (const report of await everyReport()) {
    assert.deepEqual(report.findings, [...report.findings].sort(compareFindings))
  }
})

test('every column entry uses a known type and carries the counts behind it', async () => {
  for (const report of await everyReport()) {
    for (const column of report.columns) {
      assert.ok(COLUMN_TYPES.includes(column.type), column.type)
      assert.equal(
        column.values.examined,
        column.values.total - column.values.missing - column.values.oversized - column.values.unprintable,
        'examined must be the total less every reason a value was not examined',
      )
      assert.equal(column.values.numeric + column.values.other, column.values.examined)
      if (column.numeric !== null) {
        assert.ok(CATALOG.verdicts.includes(column.numeric.verdict))
        assert.ok(CATALOG.methods.includes(column.numeric.method))
        if (column.numeric.verdict === 'undetermined') assert.ok(column.numeric.reason.length > 0)
      }
    }
  }
})

test('stdout is exactly one JSON document and ends with one newline', async () => {
  const result = await runCli(['--csv', join(EXAMPLES, 'clean', 'orders.csv'), '--json'])
  assert.equal(result.stdout.endsWith('}\n'), true)
  assert.equal(result.stdout.slice(0, -1).includes('\n}\n'), false)
  assert.equal(renderReport(JSON.parse(result.stdout)), result.stdout)
})

test('the tool id equals the package name and the directory it lives in', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(manifest.name, TOOL_ID)
  assert.equal(ROOT.split('/').pop(), TOOL_ID)
  assert.equal(CATALOG.toolId, TOOL_ID)
})

test('the README documents every rule and every limit, and invents none', async () => {
  const readme = await readFile(join(ROOT, 'README.md'), 'utf8')
  const documentedRules = [...readme.matchAll(/^\| `([a-z][a-z0-9-]*)` \| (?:error|warning|info) \|/gmu)]
    .map((match) => match[1])
  assert.deepEqual([...documentedRules].sort(), [...RULE_IDS].sort())

  for (const ruleId of RULE_IDS) {
    const severity = CATALOG.ruleSeverity[ruleId]
    assert.ok(readme.includes(`| \`${ruleId}\` | ${severity} |`), `${ruleId} must be documented as ${severity}`)
  }
  for (const name of CATALOG.limitNames) {
    assert.ok(readme.includes(`\`${name}\``), `the README must document ${name}`)
    assert.ok(readme.includes(String(CATALOG.defaultLimits[name])), `the README must state the default for ${name}`)
  }
  for (const [name, range] of Object.entries(CATALOG.numberRanges)) {
    assert.ok(readme.includes(`\`${name}\``), `the README must document ${name}`)
    assert.ok(readme.includes(String(range.fallback)), `the README must state the default for ${name}`)
  }
  for (const method of CATALOG.methods) {
    assert.ok(readme.includes(`\`${method}\``), `the README must document the ${method} method`)
  }
})
