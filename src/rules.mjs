/**
 * The rule catalog, the severity table, and the function that turns findings
 * into a status.
 *
 * Two invariants are enforced here rather than trusted:
 *
 * 1. Severity is declared exactly once, in `RULE_SEVERITY`. Every finding takes
 *    its severity from that table and an unknown rule id throws rather than
 *    defaulting to something harmless. Severity is not a label -- it is the
 *    exit code.
 * 2. `status` is a function of the findings alone. There is no `incomplete`
 *    flag to delete. A run that could not settle a question reports
 *    `incomplete`, and `incomplete` outranks `fail`: a profile built from six
 *    rows has not established that the distribution is clean, and saying so
 *    quietly would be worse than saying nothing.
 */

import { SafeMessage, assertNoForbiddenClaim, byCodeUnit, sanitize } from './text.mjs'

export const SEVERITIES = Object.freeze(['error', 'warning', 'info'])

/** The one place a severity is written down. */
export const RULE_SEVERITY = Object.freeze({
  'baseline-column-absent': 'error',
  'baseline-entry-missing': 'warning',
  'categories-truncated': 'warning',
  'category-comparison-incomplete': 'warning',
  'category-drift': 'error',
  'column-limit-exceeded': 'error',
  'column-mixed-types': 'warning',
  'column-not-evaluable': 'warning',
  'csv-empty': 'error',
  'csv-not-utf8': 'error',
  'csv-too-large': 'error',
  'csv-unreadable': 'error',
  'csv-unterminated-quote': 'error',
  'dispersion-degenerate': 'warning',
  'drift-undetermined': 'warning',
  'duplicate-column': 'error',
  'examples-limited': 'info',
  'field-too-long': 'warning',
  'header-column-unusable': 'error',
  'missingness-above-threshold': 'error',
  'missingness-drift': 'error',
  'no-rows-profiled': 'error',
  'numeric-outlier': 'error',
  'row-field-count-mismatch': 'error',
  'row-limit-exceeded': 'error',
  'row-malformed': 'error',
  'sample-too-small': 'warning',
  'unexpected-category': 'error',
  'value-unprintable': 'warning',
})

export const RULE_IDS = Object.freeze(Object.keys(RULE_SEVERITY).sort(byCodeUnit))

/**
 * The rules that mean a question this run was asked stayed unsettled.
 *
 * Membership here -- not severity -- is what makes a run `incomplete`, and for
 * the `warning` members it is the ONLY thing standing between an unsettled
 * question and a green exit. Each of them says the same thing in a different
 * place: a verdict was not reached, and the absence of an anomaly finding must
 * not be read as the absence of an anomaly.
 *
 * `numeric-outlier`, `unexpected-category`, `missingness-above-threshold`,
 * `missingness-drift` and `category-drift` are deliberately absent: each is a
 * positive finding about evidence the run did obtain, which is a policy failure
 * and not a gap.
 */
export const UNSETTLED_RULES = Object.freeze([
  'baseline-column-absent',
  'baseline-entry-missing',
  'categories-truncated',
  'category-comparison-incomplete',
  'column-limit-exceeded',
  'column-mixed-types',
  'column-not-evaluable',
  'csv-empty',
  'csv-not-utf8',
  'csv-too-large',
  'csv-unreadable',
  'csv-unterminated-quote',
  'dispersion-degenerate',
  'drift-undetermined',
  'duplicate-column',
  'field-too-long',
  'header-column-unusable',
  'no-rows-profiled',
  'row-field-count-mismatch',
  'row-limit-exceeded',
  'row-malformed',
  'sample-too-small',
  'value-unprintable',
])

const UNSETTLED_SET = new Set(UNSETTLED_RULES)

export function severityFor(ruleId) {
  const severity = RULE_SEVERITY[ruleId]
  if (severity === undefined) throw new Error(`Unknown ruleId "${ruleId}"`)
  return severity
}

export function marksUnsettled(ruleId) {
  severityFor(ruleId)
  return UNSETTLED_SET.has(ruleId)
}

export function makeFinding(ruleId, message, location, extra = {}) {
  if (!(message instanceof SafeMessage)) {
    throw new Error(`Finding "${ruleId}" must build its message with the msg tagged template`)
  }
  const finding = { ruleId, severity: severityFor(ruleId), message: message.text, location }
  if (extra.evidence !== undefined) finding.evidence = sanitize(extra.evidence)
  if (extra.suggestion !== undefined) {
    assertNoForbiddenClaim(extra.suggestion, 'A finding suggestion')
    finding.suggestion = sanitize(extra.suggestion)
  }
  return finding
}

/** Findings sort by (file, pointer, ruleId, message), each by UTF-16 code unit. */
export function compareFindings(a, b) {
  return (
    byCodeUnit(a.location.file ?? '', b.location.file ?? '')
    || byCodeUnit(a.location.pointer ?? '', b.location.pointer ?? '')
    || byCodeUnit(a.ruleId, b.ruleId)
    || byCodeUnit(a.message, b.message)
  )
}

export function sortFindings(findings) {
  return [...findings].sort(compareFindings)
}

/** Status is a function of the findings alone. There is no flag to delete. */
export function statusFor(findings) {
  for (const finding of findings) {
    if (UNSETTLED_SET.has(finding.ruleId)) return 'incomplete'
  }
  for (const finding of findings) {
    if (finding.severity === 'error') return 'fail'
  }
  return 'pass'
}
