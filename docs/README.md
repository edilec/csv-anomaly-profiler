# csv-anomaly-profiler design notes

The README is the contract. These are the decisions behind it, kept where the
next person to change the tool will look for them.

## The three refusals are the product

A profiler that always produces a verdict is easy to write and worthless to read.
The value here is in the cases where it declines: too small a sample, a zero
deviation, a column of mixed types. Each of those has a plausible-looking answer
available -- a median over six points, a score divided by zero, a fence around
whatever parsed -- and each of those answers is arithmetic rather than evidence.

The refusals are wired to the exit code rather than to a field in the report,
because a field is a thing people stop reading. `sample-too-small`,
`dispersion-degenerate` and `column-mixed-types` are all warnings AND all in the
unsettled set: membership of that set, not severity, is what turns the run
`incomplete`, and for these three it is the only thing between an open question
and a green exit.

## Both sides of the category comparison

The baseline is the index. It is validated up front and refused entry by entry,
so the index a comparison runs against is either whole or absent -- there is no
third state for a later comparison to misread.

The observed side can still lose evidence: a value over `maxCategoryLength`, a
value carrying a control character, a column past `maxDistinctCategories`. When
that happens the two halves of the comparison are treated differently, and the
difference is the whole point:

- A value this run SAW and the baseline does not list is reported. That finding
  does not depend on what else was dropped.
- Whether the column holds OTHER values the baseline does not list is exactly
  what a truncated index cannot say. `category-comparison-incomplete` is raised,
  and the run is incomplete.
- A distance computed against a partial index is a number with no meaning, so
  `drift-undetermined` is raised and no distance is printed at all.

## A value is compared as it prints

The report prints a value with its whitespace collapsed, so that is the form a
category is indexed and compared by -- on both sides. The alternative was
measured rather than imagined: indexing the raw text and printing the rendered
text made a padded export (`id, region` with `R-1, north`) raise
`category-drift` and one `unexpected-category` per value, at error severity, on
data that matched its baseline exactly, and print *"region holds the value north
... and the baseline does not list it"* beside a baseline listing `north`. A
reader is told a value is absent from a list that contains the text they are
reading.

Two consequences, both deliberate:

- A baseline value that does not print as it is written is refused when the
  document is read. It could never match an observed value, and the finding
  about it would print the two as the same text while calling them different.
  The ambiguity is refused where it can be corrected.
- A whitespace difference is still a difference, so it is reported --
  `category-whitespace-collapsed`, at `info`, which says which difference it is
  and leaves the exit code alone. Silently normalising and saying nothing would
  be the other half of the same dishonesty.

The same rule decides what happens to a value that prints as nothing at all. It
cannot be named in a report, so nothing is claimed about it: it is counted
`value-unprintable`, it is not examined, and the index that dropped it is not
called complete.

### Layout is not a hidden character

Tab, line feed and carriage return are the exception, and the reason is RFC 4180
section 2.6: a field containing a line break is enclosed in double quotes. That
is what quoting is FOR. Counting such a value `value-unprintable` made every
export carrying a multi-line note permanently `incomplete` at exit 2 -- a
refusal aimed at hidden characters, landing on the most ordinary use of the
format the tool claims to read.

The line between the two is what an exporter emits to lay a value out. A tab and
a line break are layout, they collapse to a space, and the value prints
faithfully. U+0085, U+009B, U+202E, U+FEFF and the rest are not layout: they
forge lines, reverse text or hide it. Those still make a value unprintable, and
`values.reshaped` keeps the collapse visible in every column rather than letting
it pass in silence.

A column NAME forgives none of them, layout included. A name is an identity, and
`a<TAB>b` and `a b` printing the same text would silently become one column.

## A blank line is not a ragged row

The reader hands a blank line to the profiler as a row of one empty field,
because that is what the bytes say. The profiler then could not align it to a
two-column header and reported `row-field-count-mismatch` at error severity,
exiting 2 on a file whose only irregularity was the blank line a text editor
leaves at the end.

The reading it takes now: a line holding no character at all carries no value to
attribute, so it is skipped. Two things keep that from becoming a silent drop.

- It is counted and named -- `summary.rowsBlank` and `blank-line-skipped` at
  `info` -- because a line passed over in silence is the other half of the same
  defect.
- The reader, not the profiler, decides what is blank. `""` on its own line is a
  row whose single value is the empty string, and the two are indistinguishable
  once the fields are parsed, so the reader carries a `blank` flag out with the
  row. A guess made after the fact would drop a real row.

A header of exactly one column is the exception, and it is not a special case so
much as the same rule: there an empty line IS a row whose single value is empty,
and no other reading is available.

## Why the category index is conditional

Only a column the baseline declares `allowed` or `categories` for is indexed. A
numeric column with twenty thousand distinct values would otherwise fill an index
nobody asked for, hit `maxDistinctCategories`, and report itself as truncated --
turning a perfectly good run into an incomplete one for no reason. Over-refusing
is its own defect.

## Memory is bounded by two products, not by hope

A per-key ceiling is not enough: `maxRows` and `maxColumns` multiply into the
retained numeric values, and `maxColumns`, `maxDistinctCategories` and
`maxCategoryLength` multiply into the category index. Both products are checked
while the configuration is validated, before a file is opened, and the defaults
sit at or under the caps. A tool that dies of heap exhaustion at a size its own
documentation calls legal has already happened in this catalog.

## Row numbers

Findings name the line a person would count to in the file, with the header as
line 1. A finding that names a zero-based index into the data rows is a finding
somebody will act on in the wrong place.

## Fixtures

Every file in `examples/` is invented: order references, region names, warehouse
codes and readings. Nothing describes a real person, a real customer or a real
system, and no file was copied from anywhere.
