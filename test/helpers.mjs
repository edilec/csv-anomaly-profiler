import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { profileCsv } from '../src/index.mjs'

const run = promisify(execFile)

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
export const BIN = join(ROOT, 'bin', 'csv-anomaly-profiler.mjs')
export const EXAMPLES = join(ROOT, 'examples')

export async function withTempDir(body) {
  const directory = await mkdtemp(join(tmpdir(), 'csv-anomaly-profiler-'))
  try {
    return await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function writeText(directory, name, text) {
  const path = join(directory, name)
  await writeFile(path, text, 'utf8')
  return path
}

export async function writeJson(directory, name, value) {
  return writeText(directory, name, `${JSON.stringify(value, null, 2)}\n`)
}

/** Profile a CSV document written to a temporary file, in process. */
export async function profileText(csvText, { config = null, baseline = null, method = null } = {}) {
  return withTempDir(async (directory) => {
    const csv = await writeText(directory, 'data.csv', csvText)
    const configPath = config === null
      ? null
      : await writeJson(directory, 'config.json', { schemaVersion: '1', ...config })
    const baselinePath = baseline === null
      ? null
      : await writeJson(directory, 'baseline.json', { schemaVersion: '1', ...baseline })
    return profileCsv({ csv, config: configPath, baseline: baselinePath, method })
  })
}

export function columnNamed(report, name) {
  return report.columns.find((column) => column.name === name) ?? null
}

export function ruleIds(report) {
  return report.findings.map((finding) => finding.ruleId)
}

export function findingsFor(report, ruleId) {
  return report.findings.filter((finding) => finding.ruleId === ruleId)
}

/** A CSV document from a header and rows. */
export function csvText(header, rows) {
  return [header.join(','), ...rows.map((row) => row.join(','))].join('\n') + '\n'
}

/** Run the real CLI and report exactly what a shell would see. */
export async function runCli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [BIN, ...args], { maxBuffer: 32 * 1024 * 1024 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}
