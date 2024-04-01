# csv-anomaly-profiler

Stream a delimited file and report what its columns look like: how much is
missing, which numbers sit outside a robust fence, which category values a
baseline does not permit, and how far the column has drifted from that baseline.

- **Repository:** [edilec/csv-anomaly-profiler](https://github.com/edilec/csv-anomaly-profiler)
- **Area:** Data & Analytics
- **License:** MIT

## Why it exists

A profiler is easy to write and easy to write dishonestly. The dishonest version
computes a median over whatever parsed, places a fence around it, finds nothing
outside, and prints a clean column. It has told you nothing and made it look like
something, and the next person reads the green output as evidence.

So this tool **refuses**, out loud, in three situations:

| Situation | Why a verdict would be worthless |
| --- | --- |
| Fewer values than `minSample` | An order statistic over a handful of points is not a description of a distribution |
| A deviation of zero | The score becomes a division by zero, which reports every value that is not the median as outlying: a confident answer produced by arithmetic rather than by evidence |
| A column that is part numbers and part text | A fence computed from the rows that happen to parse describes a column that does not exist |

Each refusal is a finding with a reason, the column is marked `undetermined`, and
the run exits 2. That is the whole point: the absence of an outlier finding must
never be readable as the absence of an outlier.

The same rule governs the baseline comparison. With no baseline, this tool makes
no claim about drift or about unexpected values at all -- not "no drift", not
"nothing unexpected". It does not answer a question nobody gave it the evidence
for.

## Quick start

```sh
# A file that matches its baseline: every column gets the verdict it was asked
# for and none of them fails a threshold.
node bin/csv-anomaly-profiler.mjs \
  --csv examples/clean/orders.csv \
  --baseline examples/clean/baseline.json
# exit 0, status "pass"

# The same shape with a planted outlier, a category the baseline does not list,
# and a column that started going missing.
node bin/csv-anomaly-profiler.mjs \
  --csv examples/anomalous/orders.csv \
  --baseline examples/anomalous/baseline.json
# exit 1, status "fail"

# Six rows and a column that is part letters: neither supports a verdict.
node bin/csv-anomaly-profiler.mjs --csv examples/incomplete/readings.csv
# exit 2, status "incomplete"
```

`stdout` carries the JSON report and nothing else, so it pipes straight into a
parser. The human summary goes to `stderr`, and `--json` silences it.

## Input: the file

Comma separated, UTF-8, RFC 4180 quoting, first line the header. It is read in
one pass, holding one row and a bounded set of values at a time.

Three shapes RFC 4180 does not describe, and what this reader does with each.
Two of them are **deviations** from the specification, said plainly rather than
dressed up as what the grammar meant:

| Shape | Reading | Standing |
| --- | --- | --- |
| `ab"cd` | Kept as a literal quote character | A deviation. RFC 4180's `non-escaped` production excludes `"`, so a strict reader refuses the row. This one accepts it, because the field did not open with a quote and so no quote inside it can be closing one: only one reading of the data is available |
| `"ab"c` | The row is reported as malformed and is **not profiled** | The grammar really does run out here -- after a closing quote only a comma or a line ending may follow -- and the two readings of `c` differ in what the data IS |
| A lone `CR` | Kept as data, not a record separator | A deviation, for the same reason: `non-escaped` excludes `CR`. Keeping it costs nothing, because a carriage return is layout: the value is examined and printed with its whitespace collapsed, and the difference is counted in `values.reshaped` |

A row whose field count does not match the header is **not** spread across the
columns on a guess about which field is missing: it is reported and skipped. A
rate or a fence is then computed over a subset of the file, so neither is
reported as a comparison that was made: see `evidence` below.

A line holding nothing at all is not such a row -- it is not a row. It carries no
value to attribute, every reader of this format skips it, and a text editor
leaves one at the end of a file, so it is skipped, counted in `summary.rowsBlank`
and named by `blank-line-skipped` at `info`. A header of exactly one column is
the exception: there an empty line **is** a row whose single value is empty and
the file cannot mean anything else, so it is profiled as one. `""` alone on a
line is a row with one empty field in either case, and the reader is what tells
the two apart.

A header name must print exactly as it is stored and be at most 128 characters.
`a<U+0001>b` and `a b` print the same and are two different columns, so accepting
the first would silently merge them; instead the run stops.

Padding around a header is the one exception, because `id, region` is an ordinary
export and RFC 4180 keeps the space in the value. Leading and trailing spaces and
tabs are dropped from the column's **identity**. Two headers that differ only by
padding then collapse onto one name and are caught as a `duplicate-column`, which
is what makes dropping it safe.

## A value is compared as it prints

The same export pads its values, and the report prints a value with its
whitespace collapsed. So the whitespace-collapsed form is what a category is
indexed and compared by, on both sides of the comparison:

- an observed value is indexed by the form the report prints, so ` north` and
  `north` are one value and the padded export raises nothing about its data;
- a baseline that declares ` north` is **refused** when the document is read,
  because a declared value that prints differently from the way it is written
  could never match an observed one;
- a value that prints as nothing at all -- one that is only spaces -- is counted
  `value-unprintable` and is not examined, exactly as a value carrying a hidden
  character is. It cannot be named in a report, so no claim is made about it.

Tab, line feed and carriage return are **layout**, and a value carrying one is
examined. RFC 4180 section 2.6 encloses a field containing a line break in
double quotes -- it is the one thing quoting exists for -- so an export with
multi-line notes must not be permanently `incomplete`. Collapsing the break to a
space prints the value faithfully, and `values.reshaped` counts the values whose
stored text differs from the text the report prints.

Nothing else in the unsafe set is layout, and none of it is examined: U+0085 and
U+009B forge lines in a report, U+202E reverses displayed text, U+FEFF and the
other format characters hide it, and U+2028/U+2029 terminate a line inside a
JavaScript string. A value carrying any of them is `value-unprintable`. A column
**name** forgives none of them, layout included: two names printing the same text
would silently become one column.

Asking one question about the raw text and printing the answer about the
rendered text is how a checker comes to say *"region holds the value north ...
and the baseline does not list it"* beside a baseline that lists `north`. A
whitespace difference is still a difference, so it is reported -- as
`category-whitespace-collapsed`, at `info`, which says which difference it is
and leaves the exit code alone.

## Input: the baseline

```json
{
  "schemaVersion": "1",
  "source": "orders-week-11",
  "columns": {
    "region": {
      "missingRate": 0.0,
      "allowed": ["north", "south", "east"],
      "categories": { "north": 0.3333, "south": 0.3333, "east": 0.3334 }
    },
    "units": { "missingRate": 0.0 }
  }
}
```

- `allowed` is the permitted category set. A value observed and not listed is an
  `unexpected-category`.
- `categories` are prior shares and must sum to 1 within 0.001. A set of shares
  that is not a distribution would give a distance with no meaning.
- `missingRate` is the prior rate, compared against the observed one.

The baseline is the **index** every comparison is made against, so an entry that
could not be used is refused when the document is read -- never dropped quietly.
Evidence dropped while building an index makes every comparison against it
incomplete; it does not make the comparison clean.

A column the baseline does not mention raises `baseline-entry-missing`, and a
baseline column the file does not have raises `baseline-column-absent`. Both make
the run incomplete: a comparison you asked for and did not get is a gap, not a
pass.

Every key inside an entry is optional, and the column's `drift.compared` reports
whether a comparison was actually made rather than whether an entry existed to
make one from. An entry that declares nothing compares nothing, and the report
says so.

When nothing was compared, `drift.reason` names the document or the evidence
that was missing -- and names the right one, because a consumer filtering on it
is deciding which file to go and correct:

| `drift.reason` | Meaning |
| --- | --- |
| `no-baseline` | the run was given no baseline |
| `no-baseline-entry` | the baseline has no entry for this column |
| `baseline-entry-declares-nothing` | the entry exists and declares neither `missingRate` nor `categories` |
| `file-not-profiled-in-full` | the entry declares a comparison and this run did not profile every row of the file, or a value in the column was too long to read |
| `no-values-observed` | the entry declares a comparison and the file supplied no value to make it from |
| `observed-index-incomplete` | the entry declares `categories` and the observed index dropped a value, so a distance would be a number with no meaning |

When more than one declared comparison is withheld the reason is the first in
that order, and `drift.missingRate` and `drift.categories` say which of them
produced a number.

## Input: the configuration

```json
{
  "schemaVersion": "1",
  "method": "mad",
  "minSample": 12,
  "outlierThreshold": 3.5,
  "iqrMultiplier": 1.5,
  "maxMissingRate": 0.2,
  "maxMissingRateDrift": 0.1,
  "maxCategoryDrift": 0.2,
  "maxExamples": 8,
  "missingTokens": [""],
  "limits": { "maxRows": 20000 }
}
```

Every key is optional except `schemaVersion`, and **an unknown key is refused**
rather than ignored: a one-character typo in a threshold must not turn a real
failure into a green run.

## Methods

| Method | Centre | Dispersion | A value is outside when |
| --- | --- | --- | --- |
| `mad` | median | median absolute deviation | the modified z-score, `0.6745 * (x - median) / mad`, exceeds `outlierThreshold` (default 3.5) |
| `iqr` | median | interquartile range | it falls outside `[q1 - k*iqr, q3 + k*iqr]`, `k` being `iqrMultiplier` (default 1.5) |

Each outlier example carries a `score`, and the two methods measure different
things with it: under `mad` it is the modified z-score itself, the quantity
`outlierThreshold` is compared against; under `iqr` it is how far past the fence
the value lies, counted in interquartile ranges. The finding text says which,
and never quotes one method's threshold beside the other's score.

Quantiles use linear interpolation between the closest ranks -- the definition R
calls type 7 and NumPy calls `linear`. It is named because different definitions
put a fence in a different place, and the number in the report has to be
re-derivable.

The two methods genuinely disagree, which is why `--method` exists and why the
report records which one ran. Fifteen values from 10 to 24 with one at 36: the
interquartile fence ends at 32.5 and reports it, while the median absolute
deviation puts it at a modified z-score of 3.12, inside the default threshold.

## Column types

| Type | Meaning |
| --- | --- |
| `numeric` | every value examined read as a number |
| `categorical` | none of them did |
| `mixed` | some did and some did not. No numeric verdict is reported |
| `undetermined` | no value was examined at all |

| Verdict | Meaning |
| --- | --- |
| `evaluated` | a fence was placed over every value the column holds |
| `partial` | a fence was placed over the values this run could read, and the column holds others it could not |
| `undetermined` | no fence was placed, and `reason` says why |

## What a column entry carries

```json
{
  "name": "units",
  "index": 3,
  "pointer": "/columns/units",
  "type": "numeric",
  "values": { "total": 24, "missing": 0, "examined": 24, "numeric": 24, "other": 0,
              "oversized": 0, "unprintable": 0, "categoryOversized": 0, "reshaped": 0 },
  "evidence": { "rowsComplete": true, "missingRateExact": true, "valuesComplete": true },
  "missingRate": 0,
  "numeric": { "verdict": "evaluated", "reason": null, "method": "mad", "examined": 24,
               "median": 42, "dispersion": 2, "threshold": 3.5, "constant": 0.6745,
               "fences": null, "outlierCount": 1,
               "examples": [{ "row": 19, "value": 99999, "score": 33710.49825 }] },
  "categories": { "tracked": false, "reason": "no-baseline" },
  "drift": { "compared": false, "reason": "no-baseline", "missingRate": null, "categories": null }
}
```

- `values.examined` is the total less everything that was not read: missing,
  oversized and unprintable. `numeric + other` always equals it.
- `evidence` says what the column's numbers cover. `rowsComplete` is false when
  a row of the file was never read, could not be read, or could not be aligned
  to the header. `missingRateExact` adds that no value in this column was cut
  short -- a value that was cut short was never compared with the missing
  tokens, so it might have been one. `valuesComplete` adds that every value that
  reached the profile could also be examined.
- `numeric` is `null` for a categorical column -- there was no numeric question
  to answer -- and carries `verdict: "undetermined"` with a `reason` for a column
  that had one and could not support it. An undetermined verdict has **no**
  `outlierCount`: there is no count to report, so none is reported.
- `verdict: "partial"` is the numeric counterpart of an incomplete category
  index: a fence was placed and every value outside it is reported, but it was
  computed from a subset of the column, so the **absence** of a value outside the
  fence establishes nothing. It is reached whenever `evidence.valuesComplete` is
  false, and every reason for that also raises a finding in the unsettled set --
  so a partial verdict can never appear in a green run.
- `fences` is filled under `iqr` and `null` under `mad`; `constant` the other way
  round. Each method reports what it actually used.
- `categories.tracked` is `false` unless the baseline declares `allowed` or
  `categories` for the column, and `reason` says which of the two reasons applies.
- `values.reshaped` counts the values whose stored text differs from the text the
  report prints -- a whitespace difference and nothing else, since anything else
  is `value-unprintable` and is never examined.
- `drift.compared` says whether a comparison was made, not whether an entry
  existed to make one from.

## Rules

| Rule | Severity | Raised when |
| --- | --- | --- |
| `baseline-column-absent` | error | the baseline describes a column the file does not have |
| `baseline-entry-missing` | warning | the file has a column the baseline says nothing about |
| `blank-line-skipped` | info | a line held nothing at all and was skipped, and the header declares more than one column |
| `categories-truncated` | warning | a column holds more distinct values than `maxDistinctCategories` |
| `category-comparison-incomplete` | warning | a value could not be added to the index the comparison uses |
| `category-drift` | error | the distribution is further from the baseline than `maxCategoryDrift` |
| `category-whitespace-collapsed` | info | a compared value carries whitespace this report collapses, so it was compared as it prints |
| `column-limit-exceeded` | error | the header declares more columns than `maxColumns` |
| `column-mixed-types` | warning | a column is part numbers and part text |
| `column-not-evaluable` | warning | a column had rows and no value was examined |
| `csv-empty` | error | the file holds no header row |
| `csv-not-utf8` | error | the bytes are not valid UTF-8 |
| `csv-too-large` | error | the file is over `maxBytes` |
| `csv-unreadable` | error | the file could not be opened |
| `csv-unterminated-quote` | error | a quoted field was left open at the end of the file |
| `dispersion-degenerate` | warning | the deviation is zero, so no fence can be placed |
| `drift-undetermined` | warning | the observed index dropped a value, so no distance is reported |
| `duplicate-column` | error | the header uses one name twice |
| `examples-limited` | info | more outliers or unexpected values than the report lists. The count stays exact |
| `field-too-long` | warning | a value is longer than `maxFieldLength` and was not read |
| `header-column-unusable` | error | a header name would not print as it is stored, or is too long |
| `missingness-above-threshold` | error | a column is missing more often than `maxMissingRate` |
| `missingness-drift` | error | the missing rate moved further than `maxMissingRateDrift` |
| `no-rows-profiled` | error | no data row was profiled, so the run establishes nothing |
| `numeric-outlier` | error | a value is outside the fence the selected method placed |
| `row-field-count-mismatch` | error | a row does not hold the fields the header declares |
| `row-limit-exceeded` | error | the file holds more data rows than `maxRows` |
| `row-malformed` | error | a row could not be read as delimited text |
| `sample-too-small` | warning | fewer values than `minSample` were examined |
| `unexpected-category` | error | a value was seen that the baseline does not list |
| `value-unprintable` | warning | a value carries a control or formatting character that is not layout, or prints as nothing at all |

Every warning above is in the unsettled set, so it produces `incomplete` and exit
2 rather than a green run. The five positive findings -- `numeric-outlier`,
`unexpected-category`, `missingness-above-threshold`, `missingness-drift` and
`category-drift` -- are deliberately not: each is a statement about evidence the
run did obtain, which is a policy failure and not a gap.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | every column got the verdict it was asked for and none failed a threshold |
| `1` | the run completed and a column failed a threshold |
| `2` | invalid configuration or baseline, or evidence the run could not obtain |

Exit 2 has two shapes, and the difference matters to anything that pipes stdout:

| Situation | stdout | stderr |
| --- | --- | --- |
| invalid configuration or baseline, unknown option, bad usage | **empty** | the message |
| a file that could not be read or decoded, or a question left open | an `incomplete` report | optional diagnostics |

## Limits

Each limit is enforced **before** the work it bounds. The file size is taken from
the file system before anything is opened and counted again as the bytes arrive.
The row bound stops the reader; the column bound stops the run; and a field past
the field bound stops being accumulated and is marked, so a value that was cut
short is never examined as though it were whole. Two products are checked while
the configuration is validated, before a file is opened, so that a file this tool
calls legal cannot exhaust memory:

- `maxRows` multiplied by `maxColumns` may not exceed 2000000 retained values
- `maxColumns` multiplied by `maxDistinctCategories` and `maxCategoryLength` may
  not exceed 33554432 retained characters

| Limit | Default | Ceiling |
| --- | ---: | ---: |
| `maxBytes` | 33554432 | 134217728 |
| `maxRows` | 20000 | 200000 |
| `maxColumns` | 100 | 1024 |
| `maxFieldLength` | 8192 | 65536 |
| `maxDistinctCategories` | 512 | 4096 |
| `maxCategoryLength` | 128 | 1024 |

| Setting | Default | Range |
| --- | ---: | --- |
| `minSample` | 12 | 4 to 100000 |
| `outlierThreshold` | 3.5 | above 0, to 100 |
| `iqrMultiplier` | 1.5 | above 0, to 100 |
| `maxMissingRate` | 0.2 | 0 to 1 |
| `maxMissingRateDrift` | 0.1 | 0 to 1 |
| `maxCategoryDrift` | 0.2 | 0 to 1 |
| `maxExamples` | 8 | 1 to 100 |

Fixed, and not configurable: the configuration document is capped at 65536 bytes,
the baseline at 1048576, `missingTokens` at 16 entries, a header name at 128
characters, and a column entry shows at most 10 category values.

Exceeding any limit is an `incomplete` result with a finding naming the limit. It
is never a silent truncation and never a pass. The one exception is
`examples-limited`, which is `info` because the **count** stays exact and only the
listing is shortened.

A category index is only built for a column the baseline declares `allowed` or
`categories` for. A numeric column with twenty thousand distinct values would
otherwise fill an index nobody asked for and report it as truncated.

## Non-goals

- **It connects to nothing.** No database, no warehouse, no host, no network call
  of any kind, in the tool or in its tests. The input is a file somebody exported.
- **It writes no file.** The report goes to stdout. There is no `--out`, no
  auto-fix and no destination to get wrong.
- **It reads no clock.** No wall-clock time, locale or filesystem order reaches
  the output; two runs over one file produce byte-identical stdout.
- **It is not a statistical test.** There is no hypothesis, no model, no
  significance and no interval. A value outside a fence is a value outside a
  fence, computed from the other values in its own column.
- **It does not say a value is wrong.** A point outside a fence may be the
  interesting part of the data. What to do about it is a question about the data,
  and the file does not answer it.
- **Comma separated only.** Other delimiters, other quote characters and files
  with no header are not read, and are not guessed at.
- **Whole-value numerics only.** `1,234` is two fields to a reader of this format
  and a thousands separator to a person; this tool does not choose between them.

## Repository layout

- `src/` — the library: text boundary, rule catalog, order statistics, the
  streaming reader, configuration, baseline, column profile, report assembly
- `bin/` — the command-line entry point
- `examples/` — three runnable corpora: passing, failing and incomplete
- `test/` — `node:test` suites covering the acceptance criteria item by item
- `docs/` — design notes

## Development

```sh
npm run check   # lint, tests, all three examples, and a packaging dry run
```

Zero runtime dependencies and zero development dependencies: Node's own test
runner and assertion library, and nothing else.

## License

MIT. See [LICENSE](./LICENSE).
