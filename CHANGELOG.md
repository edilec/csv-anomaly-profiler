# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public surface: renaming one is a breaking change and is recorded as such.

## Unreleased

### Fixed

- A padded export -- `id, region` with `R-1, north` -- raised `category-drift`
  and one `unexpected-category` per value at error severity against a baseline
  the data matched exactly, and the finding printed the value with its padding
  collapsed: *"region holds the value north ... and the baseline does not list
  it"*, beside a baseline listing `north`. The comparison used the raw text and
  the message used the rendered text. A category is now indexed and compared by
  the form the report prints, a baseline value that does not print as it is
  written is refused when the document is read, and the whitespace difference is
  reported as what it is by the new `category-whitespace-collapsed` rule (info).
- A value that prints as nothing at all -- one that is only spaces -- was
  examined and indexed under a name no report can print. It is now counted
  `value-unprintable` alongside the values carrying control characters.
- A quoted field carrying a line break -- the one shape RFC 4180 quoting exists
  for -- was counted `value-unprintable`, never examined, and made the run
  `incomplete` at exit 2, so any export with multi-line notes could never pass.
  Tab, line feed and carriage return are now treated as the layout they are:
  the value is examined and printed with its whitespace collapsed. Every other
  member of the unsafe set still makes a value unprintable, and a column name
  still forgives none of them.

- A comparison made against a partially read file was reported as a comparison
  that was made. With the row bound stopping the read at 20 of 100 rows,
  `missingness-drift` was raised at error severity with a delta of 0.8 -- on a
  file whose real missing rate was exactly the baseline's -- and
  `numeric.verdict` stayed `evaluated` with `outlierCount: 0` over a column
  four fifths of which had never been read. Every rate and distribution
  comparison is now gated on the evidence actually obtained, the numeric verdict
  has a third state `partial`, `summary.columnsPartial` counts it, and each
  column entry carries an `evidence` object saying what its numbers cover.

- `drift.reason` reported `baseline-entry-declares-nothing` for entries that
  declared something. The reason was assigned once and cleared only on the paths
  that compare, so a baseline declaring `categories` over an incomplete index,
  and one declaring `missingRate` over a file with no data rows, both blamed the
  baseline for a gap in the evidence -- sending a consumer to correct the
  document that was not at fault. The reason is now derived from what actually
  happened, and the vocabulary is documented and exported as `DRIFT_REASONS`.
- `drift.compared` was `true` with `drift.categories.distance` `null` when the
  observed index was whole and empty -- every value in the column missing. A
  comparison is now reported as made only when a number came out of it.

- `category-comparison-incomplete` reported the amount of dropped evidence as
  zero whenever the index had been dropped by the distinct-value cap: *"0 value
  or values in region were not added to the index this comparison uses, and the
  index reached its size limit"*. The values the cap discards are now counted
  where they are discarded, so `categories.notIndexed` and the message state the
  count a reader would arrive at by hand.

- A blank line between data rows was `row-field-count-mismatch` at error
  severity and exit 2. A line holding nothing at all carries no value to
  attribute, so it is now skipped, counted in `summary.rowsBlank` and named by
  `blank-line-skipped` at `info`. A header of exactly one column keeps the old
  reading, where an empty line is a row whose single value is empty.

### Added

- `category-whitespace-collapsed` (info), `blank-line-skipped` (info),
  `values.reshaped`, `summary.rowsBlank`, `summary.columnsPartial`,
  `column.evidence`, the `partial` verdict and the `DRIFT_REASONS` vocabulary.

## 0.1.0

First working version.

- A streaming reader that holds one row and a bounded set of values at a time,
  with the three ambiguous shapes of RFC 4180 resolved explicitly rather than
  guessed at.
- Two robust methods, `mad` and `iqr`, selectable per run and named in the
  report, with quantiles by linear interpolation between the closest ranks.
- Three refusals: too small a sample, a zero deviation, and a column of mixed
  types. Each is a finding with a reason and each makes the run incomplete.
- Missingness, unexpected categories and drift against an optional baseline. With
  no baseline, no claim about either is made at all.
- Twenty-nine rules with a frozen severity table, and an unsettled set that makes
  a run `incomplete` whenever a question it was asked stayed open.
- Declared byte, row, column, field-length, category-count and category-length
  limits, each enforced before the work it bounds, plus two product bounds
  checked while the configuration is validated.
- Three runnable corpora under `examples/`, ending at exit 0, 1 and 2.
