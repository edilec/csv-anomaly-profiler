/**
 * csv-anomaly-profiler
 *
 * Stream a delimited file and report what its columns look like: how much is
 * missing, which numbers sit outside a robust fence, which category values a
 * baseline does not permit, and how far the column has drifted from that
 * baseline.
 *
 * Three rules govern the design, and they matter more than the statistics:
 *
 * 1. THE FILE IS AN INPUT. This tool opens no connection, runs no query and
 *    resolves no host. It reads a document somebody exported, and it reads it
 *    in one pass, holding one row and a bounded set of values at a time.
 * 2. A REFUSAL IS A RESULT. A column of six numbers, a column where every value
 *    is the same, a column that is half text: none of them supports an outlier
 *    verdict, and each is reported as undetermined with the reason. A clean
 *    distribution reported over six rows has told you nothing and made it look
 *    like something.
 * 3. UNKNOWN IS NEVER A PASS, ON BOTH SIDES. The baseline is the index every
 *    category comparison is made against, so an entry that could not be used is
 *    refused when the document is read rather than dropped. On the other side,
 *    an observed index that dropped a value can still say a value it DID see is
 *    not permitted -- but it cannot say the column holds nothing unexpected,
 *    and it does not.
 *
 * The configuration and the baseline are POLICY: a problem with either means
 * the run never had a subject, so stdout stays empty and the process exits 2.
 * The file is EVIDENCE: a problem with it is a finding inside an `incomplete`
 * report, because a consumer needs to know which part was not profiled.
 */

import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

import {
  BASELINE_SCHEMA_VERSION,
  BASELINE_COLUMN_KEYS,
  BASELINE_KEYS,
  DISTRIBUTION_TOLERANCE,
  validateBaseline,
} from './baseline.mjs'
import {
  CONFIG_KEYS,
  CONFIG_SCHEMA_VERSION,
  ConfigError,
  DEFAULT_LIMITS,
  LIMIT_CEILINGS,
  LIMIT_NAMES,
  MAX_BASELINE_BYTES,
  MAX_CATEGORY_CHARACTERS,
  MAX_CELLS,
  MAX_CONFIG_BYTES,
  MAX_MISSING_TOKENS,
  METHODS,
  NUMBER_RANGES,
  defaultConfig,
  validateConfig,
} from './config.mjs'
import { createCsvReader } from './csv.mjs'
import {
  COLUMN_TYPES,
  VERDICTS,
  categoryDistance,
  categoryIndexComplete,
  examinedCount,
  missingRateOf,
  newColumn,
  numericVerdict,
  observeField,
  topCategories,
  typeOf,
  unexpectedCategories,
} from './profile.mjs'
import {
  RULE_IDS,
  RULE_SEVERITY,
  SEVERITIES,
  UNSETTLED_RULES,
  makeFinding,
  sortFindings,
  statusFor,
} from './rules.mjs'
import {
  LINE_SEPARATORS,
  at,
  byCodeUnit,
  isUsableName,
  msg,
  num,
  parseFailureDetail,
  pointerForColumn,
  sanitize,
} from './text.mjs'

export * from './baseline.mjs'
export * from './config.mjs'
export * from './csv.mjs'
export * from './profile.mjs'
export * from './rules.mjs'
export * from './stats.mjs'
export * from './text.mjs'

export const TOOL_ID = 'csv-anomaly-profiler'
export const REPORT_SCHEMA_VERSION = '1'

/** How many category values a column entry shows. */
export const MAX_TOP_CATEGORIES = 10

export const DISCLAIMER =
  'This report describes one delimited file that was supplied to it. The tool opens no connection, runs no query '
  + 'and resolves no host. A value it reports as an outlier is a value outside a robust fence computed from the '
  + 'other values in its own column: that is a description of the column, not a judgement about the value, and not '
  + 'a test of anything. A column this run could not support a verdict for is reported as undetermined with the '
  + 'reason, never as a column with nothing to report.'

export const NOT_ESTABLISHED = Object.freeze([
  'whether a value outside the fence is an error, a rare event or the interesting part of the data',
  'anything about a column whose verdict is undetermined, including that it is free of outliers',
  'anything about rows past the row limit, rows this run could not align to the header, or values it could not print',
  'whether a category the baseline does not list is new, renamed or a mistake: the file does not say',
])

const EMPTY_SUMMARY = Object.freeze({
  rows: 0,
  rowsProfiled: 0,
  rowsSkipped: 0,
  rowsBlank: 0,
  columns: 0,
  columnsEvaluated: 0,
  columnsUndetermined: 0,
  outliers: 0,
})

function configurationOf(config, baselineFile) {
  return {
    method: config.method,
    minSample: config.minSample,
    outlierThreshold: config.outlierThreshold,
    iqrMultiplier: config.iqrMultiplier,
    maxMissingRate: config.maxMissingRate,
    maxMissingRateDrift: config.maxMissingRateDrift,
    maxCategoryDrift: config.maxCategoryDrift,
    maxExamples: config.maxExamples,
    missingTokens: [...config.missingTokens],
    limits: { ...config.limits },
    baseline: baselineFile,
  }
}

function envelope({ status, findings, columns, summary, config, file, baselineFile }) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: columns.length,
      errors: findings.filter((finding) => finding.severity === 'error').length,
      warnings: findings.filter((finding) => finding.severity === 'warning').length,
      info: findings.filter((finding) => finding.severity === 'info').length,
      ...summary,
    },
    configuration: configurationOf(config, baselineFile),
    source: { file, baseline: baselineFile },
    columns,
    findings,
    disclaimer: DISCLAIMER,
    notEstablished: [...NOT_ESTABLISHED],
  }
}

function unreadableReport(findings, file, config, baselineFile) {
  const ordered = sortFindings(findings)
  return envelope({
    status: statusFor(ordered),
    findings: ordered,
    columns: [],
    summary: { ...EMPTY_SUMMARY },
    config,
    file,
    baselineFile,
  })
}

/**
 * Read the file in one pass.
 *
 * The size is taken from the file system BEFORE anything is opened, and the
 * bytes are counted again while they arrive, so a file that grows during the
 * read is refused too. Decoding is strict: a file whose bytes are not UTF-8 is
 * reported as undecodable, and encoding validity is never inferred from
 * decoded text.
 */
export async function streamCsvFile(path, config, handlers) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error' }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file' }
  if (info.size > config.limits.maxBytes) {
    return {
      status: 'too-large',
      reason: `${info.size} bytes exceeds the ${config.limits.maxBytes} byte limit`,
    }
  }

  const reader = createCsvReader({
    maxFieldLength: config.limits.maxFieldLength,
    maxColumns: config.limits.maxColumns,
    onRow: handlers.onRow,
    onProblem: handlers.onProblem,
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const stream = createReadStream(path)
  let bytes = 0
  try {
    for await (const chunk of stream) {
      bytes += chunk.length
      if (bytes > config.limits.maxBytes) {
        stream.destroy()
        return { status: 'too-large', reason: `the file grew past the ${config.limits.maxBytes} byte limit` }
      }
      reader.push(decoder.decode(chunk, { stream: true }))
      if (reader.stopped()) {
        stream.destroy()
        return { status: 'ok', reason: null }
      }
    }
    reader.push(decoder.decode())
  } catch (error) {
    stream.destroy()
    if (error instanceof TypeError) return { status: 'not-utf8', reason: 'the bytes are not valid UTF-8' }
    return { status: 'unreadable', reason: error.code ?? 'unknown error' }
  }
  reader.end()
  return { status: 'ok', reason: null }
}

/** Load and validate the configuration document. Every failure is a ConfigError. */
export async function loadConfig(configPath, method = null) {
  const withMethod = (config) => {
    if (method === null) return config
    if (!METHODS.includes(method)) {
      throw new ConfigError(`"method" must be one of ${METHODS.join(', ')}, and it was ${sanitize(method, 32)}.`)
    }
    return Object.freeze({ ...config, method })
  }
  if (configPath === null || configPath === undefined) return withMethod(defaultConfig())
  const document = await readJsonPolicy(configPath, MAX_CONFIG_BYTES, 'configuration')
  return withMethod(validateConfig(document))
}

async function readJsonPolicy(path, maxBytes, what) {
  const absolute = resolve(process.cwd(), path)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    throw new ConfigError(`The ${what} was not read: ${sanitize(error.code ?? 'unknown error')}.`)
  }
  if (!info.isFile()) throw new ConfigError(`The ${what} is not a regular file.`)
  if (info.size > maxBytes) {
    throw new ConfigError(`The ${what} is ${info.size} bytes, which exceeds the ${maxBytes} byte limit.`)
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(absolute))
  } catch {
    throw new ConfigError(`The ${what} was not read: the bytes are not valid UTF-8.`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The ${what} is not valid JSON: ${parseFailureDetail(error)}.`)
  }
}

export async function loadBaseline(baselinePath, config) {
  if (baselinePath === null || baselinePath === undefined) return null
  const document = await readJsonPolicy(baselinePath, MAX_BASELINE_BYTES, 'baseline')
  return validateBaseline(document, config.limits)
}

function headerFindings(problem, file, config) {
  if (problem.kind === 'malformed') {
    return [makeFinding(
      'row-malformed',
      msg`The header row could not be read as delimited text, so no column was profiled.`,
      at(file, '/rows/1'),
      { suggestion: 'Check the quoting on the first line.' },
    )]
  }
  if (problem.kind === 'column-limit') {
    return [makeFinding(
      'column-limit-exceeded',
      msg`The header declares ${String(problem.count)} columns and this run profiles at most
          ${String(config.limits.maxColumns)}, so nothing was profiled.`,
      at(file, '/rows/1'),
      { suggestion: 'Raise limits.maxColumns deliberately, or narrow the export.' },
    )]
  }
  if (problem.kind === 'unusable') {
    return [makeFinding(
      'header-column-unusable',
      msg`Column ${String(problem.position)} of the header does not print exactly as it is stored, or is
          longer than a column name may be, so it cannot be used as an identity and nothing was profiled.`,
      at(file, '/rows/1'),
      { suggestion: 'Give every column a plain printable name.' },
    )]
  }
  return [makeFinding(
    'duplicate-column',
    msg`The header uses the name ${problem.name} more than once, so a value could not be attributed to one
        column or the other, and nothing was profiled.`,
    at(file, '/rows/1'),
    { suggestion: 'Give every column a distinct name.' },
  )]
}

function columnReport(column, config, baseline, file) {
  const findings = []
  const pointer = pointerForColumn(column.name)
  const examined = examinedCount(column)
  const type = typeOf(column)
  const missingRate = missingRateOf(column)
  const numeric = numericVerdict(column, config)
  const indexComplete = categoryIndexComplete(column)
  const baselineEntry = baseline === null ? undefined : baseline.columns.get(column.name)

  if (column.oversized > 0) {
    findings.push(makeFinding(
      'field-too-long',
      msg`${String(column.oversized)} value or values in ${column.name} are longer than the
          ${String(config.limits.maxFieldLength)} character field limit, so they were not read. They are
          counted in the column total and apart from the values that were examined.`,
      at(file, pointer),
      { suggestion: 'Raise limits.maxFieldLength deliberately, or review the long values by hand.' },
    ))
  }
  if (column.unprintable > 0) {
    findings.push(makeFinding(
      'value-unprintable',
      msg`${String(column.unprintable)} value or values in ${column.name} do not print as they are
          stored: they carry a control or formatting character, or they print as nothing at all. They
          were not examined.`,
      at(file, pointer),
      {
        suggestion: 'Export the column without control or formatting characters, and name a blank '
          + 'placeholder in missingTokens if it stands for a value that is missing.',
      },
    ))
  }
  // Only when the column HAD rows. With no data row at all the file-level
  // finding already says so, and one copy per column would bury it.
  if (type === 'undetermined' && column.total > 0) {
    findings.push(makeFinding(
      'column-not-evaluable',
      msg`No value in ${column.name} was examined: of ${String(column.total)} rows,
          ${String(column.missing)} were missing and ${String(column.oversized + column.unprintable)}
          could not be read. Nothing is reported about this column.`,
      at(file, pointer),
      { suggestion: 'Check the export, or the missingTokens the run was given.' },
    ))
  }
  if (type === 'mixed') {
    findings.push(makeFinding(
      'column-mixed-types',
      msg`${column.name} holds ${String(column.numeric)} value or values that read as numbers and
          ${String(column.other)} that do not. A fence computed from the numeric part would describe a
          column that does not exist, so no numeric verdict is reported for this one.`,
      at(file, pointer),
      {
        suggestion: 'If the values that do not read as numbers are placeholders, name them in '
          + 'missingTokens so they count as missing; otherwise split the column or correct them.',
      },
    ))
  }
  if (numeric !== null && numeric.reason === 'sample-too-small') {
    findings.push(makeFinding(
      'sample-too-small',
      msg`${column.name} has ${String(examined)} value or values examined and this run needs
          ${String(config.minSample)} before it will place a fence. No outlier verdict is reported: a
          handful of points does not describe a distribution.`,
      at(file, pointer),
      { suggestion: 'Profile a larger extract, or lower minSample deliberately.' },
    ))
  }
  if (numeric !== null && numeric.reason === 'dispersion-degenerate') {
    findings.push(makeFinding(
      'dispersion-degenerate',
      msg`The ${config.method === 'mad' ? msg`median absolute deviation` : msg`interquartile range`} of
          ${column.name} is zero, so every value that is not the median would score infinitely far from
          it. No outlier verdict is reported.`,
      at(file, pointer),
      { suggestion: 'More than half of the values examined are identical; look at the column itself.' },
    ))
  }
  if (numeric !== null && numeric.verdict === 'evaluated') {
    for (const example of numeric.examples) {
      // The two methods report different quantities, and saying so is the point
      // of naming the method at all. Under `mad` the score IS the statistic the
      // threshold is compared against. Under `iqr` the threshold multiplies the
      // interquartile range to place a fence, and the score says how far past
      // that fence the value lies, in interquartile ranges -- so quoting the
      // threshold beside it would compare two different quantities.
      const how = config.method === 'mad'
        ? msg`whose modified z-score against the column median is ${String(example.score)}, past the
              configured ${String(numeric.threshold)}`
        : msg`which is outside the interquartile fence of ${String(numeric.fences.low)} to
              ${String(numeric.fences.high)}, by ${String(example.score)} interquartile range or ranges`
      findings.push(makeFinding(
        'numeric-outlier',
        msg`Row ${String(example.row)} of ${column.name} holds ${String(example.value)}, ${how}. The
            median is ${String(numeric.median)} over ${String(examined)} value or values examined.`,
        at(file, pointer),
        { suggestion: 'Look at the row before deciding anything: a point outside a fence may be the interesting part of the data.' },
      ))
    }
    if (numeric.outlierCount > numeric.examples.length) {
      findings.push(makeFinding(
        'examples-limited',
        msg`${column.name} has ${String(numeric.outlierCount)} value or values outside the fence and this
            report lists ${String(numeric.examples.length)} of them, the furthest first. The count is
            exact; only the listing is limited.`,
        at(file, pointer),
      ))
    }
  }
  if (missingRate !== null && missingRate > config.maxMissingRate) {
    findings.push(makeFinding(
      'missingness-above-threshold',
      msg`${column.name} is missing in ${String(column.missing)} of ${String(column.total)} rows
          profiled, a rate of ${String(missingRate)}, above the configured
          ${String(config.maxMissingRate)}.`,
      at(file, pointer),
      { suggestion: 'Check the extract, or raise maxMissingRate deliberately.' },
    ))
  }

  let categories = { tracked: false, reason: baseline === null ? 'no-baseline' : 'baseline-declares-no-categories' }
  let drift = { compared: false, reason: baseline === null ? 'no-baseline' : 'no-baseline-entry', missingRate: null, categories: null }

  if (baseline !== null && baselineEntry === undefined) {
    findings.push(makeFinding(
      'baseline-entry-missing',
      msg`The baseline says nothing about ${column.name}, so nothing about this column was compared
          against it. That is a gap in the comparison, not a comparison that passed.`,
      at(file, pointer),
      { suggestion: 'Add the column to the baseline, or run without one.' },
    ))
  }

  if (baselineEntry !== undefined) {
    // `compared` says whether a comparison was actually made, not whether an
    // entry existed to make one from. A baseline entry that declares nothing
    // compares nothing, and reporting that as compared would be the quiet half
    // of a claim this run cannot support.
    drift = { compared: false, reason: 'baseline-entry-declares-nothing', missingRate: null, categories: null }
    if (baselineEntry.missingRate !== null && missingRate !== null) {
      const delta = num(Math.abs(missingRate - baselineEntry.missingRate))
      drift.missingRate = { baseline: baselineEntry.missingRate, observed: missingRate, delta }
      drift.compared = true
      drift.reason = null
      if (delta > config.maxMissingRateDrift) {
        findings.push(makeFinding(
          'missingness-drift',
          msg`${column.name} is missing at a rate of ${String(missingRate)} and the baseline records
              ${String(baselineEntry.missingRate)}, a change of ${String(delta)}, above the configured
              ${String(config.maxMissingRateDrift)}.`,
          at(file, pointer),
        ))
      }
    }

    if (column.tracksCategories) {
      const unexpected = baselineEntry.allowed === null ? [] : unexpectedCategories(column, baselineEntry.allowed)
      categories = {
        tracked: true,
        reason: null,
        indexComplete,
        distinct: column.categories.size,
        truncated: column.categoriesTruncated,
        notIndexed:
          column.categoryOversized + column.categoryDropped + column.oversized + column.unprintable,
        top: topCategories(column, MAX_TOP_CATEGORIES),
        unexpected: unexpected.slice(0, config.maxExamples),
        unexpectedCount: unexpected.length,
      }
      if (column.reshaped > 0) {
        // A whitespace difference IS a difference and is reported -- but it is
        // reported as the difference it is. Indexing these values by their raw
        // text instead would compare one string and print another, and the
        // report would say a value is absent from a baseline that lists exactly
        // the text the finding prints.
        findings.push(makeFinding(
          'category-whitespace-collapsed',
          msg`${String(column.reshaped)} value or values in ${column.name} do not print as they are
              stored: the whitespace in them is collapsed, and they were compared as they print. That is
              a whitespace difference, not a different value.`,
          at(file, pointer),
          { suggestion: 'Trim the column in the export if the padding was not intended.' },
        ))
      }
      for (const entry of categories.unexpected) {
        findings.push(makeFinding(
          'unexpected-category',
          msg`${column.name} holds the value ${entry.value} in ${String(entry.count)} row or rows, and the
              baseline does not list it.`,
          at(file, pointer),
          { suggestion: 'Add the value to the baseline if it is expected, or look at where it came from.' },
        ))
      }
      if (unexpected.length > categories.unexpected.length) {
        findings.push(makeFinding(
          'examples-limited',
          msg`${column.name} holds ${String(unexpected.length)} value or values the baseline does not list
              and this report names ${String(categories.unexpected.length)} of them, lowest first. The
              count is exact; only the listing is limited.`,
          at(file, pointer),
        ))
      }
      if (!indexComplete) {
        // The findings above are still made: a value this run SAW and the
        // baseline does not permit is not in doubt. What is withheld is the
        // opposite claim, and this is what withholds it.
        findings.push(makeFinding(
          'category-comparison-incomplete',
          msg`${String(categories.notIndexed)} value or values in ${column.name} were not added to the
              index this comparison uses${column.categoriesTruncated ? msg`, and the index reached its size limit` : msg``}.
              Any value named above was seen and is not in the baseline; whether the column holds others
              is not established by this run.`,
          at(file, pointer),
          { suggestion: 'Raise the category limits deliberately, or correct the values that could not be indexed.' },
        ))
      }
      if (column.categoriesTruncated) {
        findings.push(makeFinding(
          'categories-truncated',
          msg`${column.name} holds more than the ${String(config.limits.maxDistinctCategories)} distinct
              values this run indexes, so the values after that were not recorded.`,
          at(file, pointer),
          { suggestion: 'Raise limits.maxDistinctCategories deliberately, or profile a column with fewer values.' },
        ))
      }

      if (baselineEntry.categories !== null) {
        if (indexComplete) {
          const distance = categoryDistance(column, baselineEntry.categories)
          drift.categories = { distance, threshold: config.maxCategoryDrift }
          drift.compared = true
          drift.reason = null
          if (distance !== null && distance > config.maxCategoryDrift) {
            findings.push(makeFinding(
              'category-drift',
              msg`The distribution of ${column.name} is ${String(distance)} away from the baseline by
                  total variation distance, above the configured ${String(config.maxCategoryDrift)}.`,
              at(file, pointer),
            ))
          }
        } else {
          // A distance computed from an index that dropped evidence is a number
          // with no meaning. None is reported.
          findings.push(makeFinding(
            'drift-undetermined',
            msg`The distribution of ${column.name} was not compared with the baseline, because the index
                this run built for it does not hold every value the column contained.`,
            at(file, pointer),
            { suggestion: 'Raise the category limits deliberately, or correct the values that could not be indexed.' },
          ))
        }
      }
    }
  }

  const entry = {
    name: column.name,
    index: column.index,
    pointer,
    type,
    values: {
      total: column.total,
      missing: column.missing,
      examined,
      numeric: column.numeric,
      other: column.other,
      oversized: column.oversized,
      unprintable: column.unprintable,
      categoryOversized: column.categoryOversized,
      reshaped: column.reshaped,
    },
    missingRate,
    numeric,
    categories,
    drift,
  }
  return { entry, findings }
}

/**
 * Profile a delimited file.
 *
 * Throws `ConfigError` for anything wrong with the configuration or the
 * baseline -- the caller exits 2 with empty stdout. Returns a report for
 * everything else, including a file that could not be read.
 */
export async function profileCsv({ csv, config: configPath = null, baseline: baselinePath = null, method = null }) {
  const config = await loadConfig(configPath, method)
  if (typeof csv !== 'string' || csv === '') throw new ConfigError('A CSV path is required.')
  const baseline = await loadBaseline(baselinePath, config)
  const absolute = resolve(process.cwd(), csv)
  const file = basename(absolute)
  const baselineFile = baselinePath === null ? null : basename(resolve(process.cwd(), baselinePath))

  const state = {
    header: null,
    headerProblem: null,
    columns: [],
    dataRows: 0,
    rowsSeen: 0,
    blankLines: 0,
    firstBlankLine: null,
    rowsProfiled: 0,
    malformed: 0,
    firstMalformed: null,
    mismatched: 0,
    firstMismatched: null,
    truncated: false,
    unterminatedQuote: false,
  }

  const onProblem = (problem) => {
    if (problem.kind === 'unterminated-quote') state.unterminatedQuote = true
  }

  const onRow = (row) => {
    const line = row.index + 1
    if (row.index === 0) {
      if (row.malformed) {
        state.headerProblem = { kind: 'malformed' }
        return false
      }
      if (row.fieldCount > config.limits.maxColumns) {
        state.headerProblem = { kind: 'column-limit', count: row.fieldCount }
        return false
      }
      const names = []
      for (let position = 0; position < row.fields.length; position += 1) {
        const field = row.fields[position]
        // Padding around a header is ordinary in an export and RFC 4180 keeps
        // it in the value, so `id, region` would otherwise refuse a file that
        // is not wrong in any way a reader would recognise. The spaces are
        // dropped from the IDENTITY and nothing else is: a name carrying a
        // control character, a bidi mark, nothing at all, or more characters
        // than a name may have is still refused, because it cannot be an
        // identity. Two headers that differ only by padding collapse onto one
        // name and are caught by the duplicate check on the next line, which is
        // what makes dropping the padding safe rather than merely convenient.
        const name = field.text.replace(/^[ \t]+/u, '').replace(/[ \t]+$/u, '')
        if (field.truncated || !isUsableName(name)) {
          state.headerProblem = { kind: 'unusable', position: position + 1 }
          return false
        }
        if (names.includes(name)) {
          state.headerProblem = { kind: 'duplicate', name }
          return false
        }
        names.push(name)
      }
      state.header = names
      state.columns = names.map((name, index) => {
        const entry = baseline === null ? undefined : baseline.columns.get(name)
        const tracks = entry !== undefined && (entry.allowed !== null || entry.categories !== null)
        return newColumn(name, index, tracks)
      })
      return true
    }

    // A line holding no character at all carries no value to attribute, so it
    // is not a row that does not match the header -- it is not a row. Most
    // readers of this format skip it, and reporting it as a ragged row sent a
    // reader to correct a file with nothing wrong with it. It is skipped,
    // counted, and named in the report, because a line that was passed over in
    // silence is the other half of the same defect.
    //
    // A header of exactly one column is the exception: there an empty line IS a
    // row whose single value is empty, and the file cannot mean anything else.
    if (row.blank && state.columns.length !== 1) {
      state.blankLines += 1
      if (state.firstBlankLine === null) state.firstBlankLine = line
      return true
    }
    state.dataRows += 1
    if (state.dataRows > config.limits.maxRows) {
      state.truncated = true
      return false
    }
    state.rowsSeen += 1
    if (row.malformed) {
      state.malformed += 1
      if (state.firstMalformed === null) state.firstMalformed = line
      return true
    }
    if (row.fieldCount !== state.columns.length) {
      state.mismatched += 1
      if (state.firstMismatched === null) state.firstMismatched = line
      return true
    }
    state.rowsProfiled += 1
    for (let position = 0; position < state.columns.length; position += 1) {
      observeField(state.columns[position], row.fields[position], line, config)
    }
    return true
  }

  const read = await streamCsvFile(absolute, config, { onRow, onProblem })
  if (read.status !== 'ok') {
    const ruleId = read.status === 'too-large'
      ? 'csv-too-large'
      : read.status === 'not-utf8' ? 'csv-not-utf8' : 'csv-unreadable'
    return unreadableReport([makeFinding(
      ruleId,
      msg`The file was not read: ${read.reason}.`,
      at(file, null),
      {
        suggestion: read.status === 'too-large'
          ? 'Raise limits.maxBytes deliberately, or split the file.'
          : 'Supply a UTF-8 delimited file at the path given to --csv.',
      },
    )], file, config, baselineFile)
  }

  const findings = []
  if (state.unterminatedQuote) {
    findings.push(makeFinding(
      'csv-unterminated-quote',
      msg`A quoted field was left open at the end of the file, so the last row was not profiled.`,
      at(file, null),
      { suggestion: 'Close the quote, or re-export the file.' },
    ))
  }
  if (state.headerProblem !== null) {
    findings.push(...headerFindings(state.headerProblem, file, config))
    return unreadableReport(findings, file, config, baselineFile)
  }
  if (state.header === null) {
    findings.push(makeFinding(
      'csv-empty',
      msg`The file holds no header row, so there is nothing to profile.`,
      at(file, null),
      { suggestion: 'Supply a delimited file whose first line names the columns.' },
    ))
    return unreadableReport(findings, file, config, baselineFile)
  }

  if (state.truncated) {
    findings.push(makeFinding(
      'row-limit-exceeded',
      msg`The file holds more than the ${String(config.limits.maxRows)} data rows this run profiles, so
          the rows after that were not read at all.`,
      at(file, '/rows'),
      { suggestion: 'Raise limits.maxRows deliberately, or profile a smaller extract.' },
    ))
  }
  if (state.blankLines > 0) {
    findings.push(makeFinding(
      'blank-line-skipped',
      msg`${String(state.blankLines)} line or lines hold nothing at all, first at line
          ${String(state.firstBlankLine)}, and were skipped. A blank line carries no value to attribute
          to the ${String(state.columns.length)} columns the header declares.`,
      at(file, '/rows'),
    ))
  }
  if (state.malformed > 0) {
    findings.push(makeFinding(
      'row-malformed',
      msg`${String(state.malformed)} row or rows could not be read as delimited text, first at line
          ${String(state.firstMalformed)}, so their values were not attributed to any column.`,
      at(file, '/rows'),
      { suggestion: 'Check the quoting on those lines.' },
    ))
  }
  if (state.mismatched > 0) {
    findings.push(makeFinding(
      'row-field-count-mismatch',
      msg`${String(state.mismatched)} row or rows do not hold the ${String(state.columns.length)} fields
          the header declares, first at line ${String(state.firstMismatched)}. Which value belongs to
          which column is not established, so none of them was attributed.`,
      at(file, '/rows'),
      { suggestion: 'Correct the rows, or re-export the file.' },
    ))
  }
  if (state.rowsProfiled === 0) {
    findings.push(makeFinding(
      'no-rows-profiled',
      msg`No data row was profiled, so this run establishes nothing about the file.`,
      at(file, '/rows'),
      { suggestion: 'Check that the file holds data rows under its header.' },
    ))
  }

  if (baseline !== null) {
    for (const name of [...baseline.columns.keys()].sort(byCodeUnit)) {
      if (state.header.includes(name)) continue
      findings.push(makeFinding(
        'baseline-column-absent',
        msg`The baseline describes a column named ${name} and the file has none, so nothing was compared
            for it.`,
        at(file, pointerForColumn(name)),
        { suggestion: 'Update the baseline, or check that the right file was profiled.' },
      ))
    }
  }

  const entries = []
  for (const column of state.columns) {
    const built = columnReport(column, config, baseline, file)
    entries.push(built.entry)
    findings.push(...built.findings)
  }
  entries.sort((a, b) => byCodeUnit(a.name, b.name))
  const ordered = sortFindings(findings)

  let outliers = 0
  let evaluated = 0
  let undetermined = 0
  for (const entry of entries) {
    if (entry.numeric === null) continue
    if (entry.numeric.verdict === 'evaluated') {
      evaluated += 1
      outliers += entry.numeric.outlierCount
    } else undetermined += 1
  }

  return envelope({
    status: statusFor(ordered),
    findings: ordered,
    columns: entries,
    summary: {
      rows: state.rowsSeen,
      rowsProfiled: state.rowsProfiled,
      rowsSkipped: state.rowsSeen - state.rowsProfiled,
      rowsBlank: state.blankLines,
      columns: entries.length,
      columnsEvaluated: evaluated,
      columnsUndetermined: undetermined,
      outliers,
    },
    config,
    file,
    baselineFile,
  })
}

const SEPARATOR_PATTERN = new RegExp(`[${LINE_SEPARATORS}]`, 'gu')
const SEPARATOR_ESCAPES = new Map(
  [...LINE_SEPARATORS].map((character) => [
    character,
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`,
  ]),
)

/**
 * Serialise the report for stdout.
 *
 * `JSON.stringify` leaves U+2028 and U+2029 raw, and inside a JavaScript string
 * literal those two are line terminators. The payload parses as JSON either
 * way, but a column name carrying one would break a consumer that evaluates the
 * payload as JavaScript, so both are escaped here as well as refused upstream.
 */
export function renderReport(report) {
  const json = JSON.stringify(report, null, 2)
  return `${json.replace(SEPARATOR_PATTERN, (character) => SEPARATOR_ESCAPES.get(character))}\n`
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((finding) => {
    const where = [finding.location.file, finding.location.pointer]
      .filter((part) => part !== undefined && part !== '')
      .map((part) => sanitize(part, 200))
      .join(' ')
    return `${finding.severity.toUpperCase().padEnd(7)} ${sanitize(finding.ruleId, 40).padEnd(32)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.columns} column(s) over ${report.summary.rowsProfiled} row(s) profiled of `
    + `${report.summary.rows} read; ${report.summary.rowsSkipped} row(s) skipped, `
    + `${report.summary.rowsBlank} blank line(s).`,
  )
  lines.push(
    `${report.summary.columnsEvaluated} column(s) got a numeric verdict under "${report.configuration.method}", `
    + `${report.summary.columnsUndetermined} did not; ${report.summary.outliers} value(s) outside the fence.`,
  )
  lines.push(
    `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info. `
    + `Status ${report.status}.`,
  )
  lines.push(report.disclaimer)
  return `${lines.join('\n')}\n`
}

/** Exported so the catalog and the limits can be asserted against the documents. */
export const CATALOG = Object.freeze({
  toolId: TOOL_ID,
  ruleIds: RULE_IDS,
  ruleSeverity: RULE_SEVERITY,
  unsettledRules: UNSETTLED_RULES,
  severities: SEVERITIES,
  methods: METHODS,
  columnTypes: COLUMN_TYPES,
  verdicts: VERDICTS,
  configKeys: CONFIG_KEYS,
  numberRanges: NUMBER_RANGES,
  limitNames: LIMIT_NAMES,
  defaultLimits: DEFAULT_LIMITS,
  limitCeilings: LIMIT_CEILINGS,
  maxCells: MAX_CELLS,
  maxCategoryCharacters: MAX_CATEGORY_CHARACTERS,
  maxConfigBytes: MAX_CONFIG_BYTES,
  maxBaselineBytes: MAX_BASELINE_BYTES,
  maxMissingTokens: MAX_MISSING_TOKENS,
  maxTopCategories: MAX_TOP_CATEGORIES,
  baselineKeys: BASELINE_KEYS,
  baselineColumnKeys: BASELINE_COLUMN_KEYS,
  distributionTolerance: DISTRIBUTION_TOLERANCE,
  configSchemaVersion: CONFIG_SCHEMA_VERSION,
  baselineSchemaVersion: BASELINE_SCHEMA_VERSION,
})
