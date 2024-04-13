#!/usr/bin/env node

import {
  ConfigError,
  exitCodeFor,
  formatSummary,
  profileCsv,
  renderReport,
  sanitize,
} from '../src/index.mjs'

const HELP = `csv-anomaly-profiler

Stream a delimited file and report what its columns look like: how much is
missing, which numbers sit outside a robust fence, which category values a
baseline does not permit, and how far the column has drifted from that baseline.

This tool reads one file and an optional baseline document. It opens no
connection, runs no query, resolves no host, reads no clock and writes no file:
the report goes to stdout.

A refusal is a result. A column of fewer values than --min-sample, a column
whose deviation is zero, and a column that is part numbers and part text each
get no outlier verdict at all -- they are reported as undetermined with the
reason, and the run exits 2. A clean distribution reported over six rows would
tell you nothing and make it look like something.

Without a baseline this tool makes no claim about drift or about unexpected
category values. Not "no drift", not "nothing unexpected": it does not answer a
question nobody gave it the evidence for.

Usage:
  csv-anomaly-profiler --csv FILE [--baseline FILE] [--config FILE]
                       [--method mad|iqr] [--json]

Options:
  --csv FILE       Delimited file to profile (required). Comma separated,
                   RFC 4180 quoting, UTF-8, first line the header.
  --baseline FILE  Baseline document: permitted categories, prior shares and
                   prior missing rates, per column
  --config FILE    Configuration: method, thresholds, missing tokens and limits
  --method NAME    mad or iqr. Overrides the configuration, and is validated the
                   same way. Default mad.
  --json           Suppress the human summary on stderr
  -h, --help       Show this help

Streams:
  stdout  the JSON report and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every column got the verdict it was asked for and none of them failed a
     threshold
  1  the run completed and a column failed a threshold: a value outside the
     fence, missingness above the limit, a category the baseline does not list,
     or drift past the limit
  2  invalid configuration or baseline, or evidence the run could not obtain. A
     file that could not be read or decoded, rows past the limit, rows that
     could not be aligned to the header, a column with too small a sample, a
     zero deviation, mixed types, a category index that could not hold every
     value, and a column the baseline says nothing about all land here, and none
     of them is ever reported as an absence of anomalies.
     On a configuration or baseline error stdout stays EMPTY and the message
     goes to stderr. On unreadable or incomplete evidence stdout carries an
     "incomplete" report naming what was not profiled.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { csv: null, baseline: null, config: null, method: null, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--csv') options.csv = takeValue('--csv')
    else if (argument === '--baseline') options.baseline = takeValue('--baseline')
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--method') options.method = takeValue('--method')
    // The option text is argv, which this tool did not write either: a newline
    // or a bidi control in it would forge lines in the diagnostic below just as
    // one in the file would.
    else throw new Error(`Unknown option "${sanitize(argument, 64)}"`)
  }

  if (options.csv === null) throw new Error('--csv is required')
  return options
}

/**
 * Write to a stream and report whether it arrived.
 *
 * A stream this process does not own can fail: `--json | head` closes the pipe
 * while the report is still going down it, and the write then emits EPIPE. With
 * nothing listening for that, Node throws it as an unhandled 'error' event --
 * which printed a stack trace carrying the ABSOLUTE path of this file, left
 * stdout with a truncated document on it, and exited 1 as though a threshold
 * had failed. The report contract forbids an absolute host path in the report;
 * a crash trace is the same leak through another door.
 *
 * The listener is what stops the throw. The callback is what lets the caller
 * say so honestly, because a report that did not arrive is an execution
 * failure, not a verdict about the file.
 */
function writeTo(stream, text) {
  return new Promise((resolve) => {
    stream.write(text, (error) => resolve(error ?? null))
  })
}

/** A write failure, said in one line, with no stack and no host path. */
function describeWriteFailure(stream, error) {
  return `The report was not written to ${stream}: ${sanitize(error.code ?? 'unknown error', 64)}.\n`
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await profileCsv({
      csv: options.csv,
      config: options.config,
      baseline: options.baseline,
      method: options.method,
    })
  } catch (error) {
    // A ConfigError means the run never had a subject: stdout stays empty, by
    // the contract. Anything else escaping here is a defect in this tool, and
    // it is reported the same way rather than as a report about the file.
    process.stderr.write(
      `${error instanceof ConfigError ? error.message : `Execution failure: ${error.message}`}\n`,
    )
    return 2
  }

  const failure = await writeTo(process.stdout, renderReport(report))
  if (failure !== null) {
    await writeTo(process.stderr, describeWriteFailure('stdout', failure))
    return 2
  }
  if (!options.json) await writeTo(process.stderr, formatSummary(report))
  return exitCodeFor(report)
}

// Without these, a failed write to either stream is an unhandled 'error' event
// and the process dies with a stack trace. Every path that writes checks the
// outcome for itself; these only keep the failure from becoming a crash.
process.stdout.on('error', () => {})
process.stderr.on('error', () => {})

process.exitCode = await main(process.argv.slice(2))
