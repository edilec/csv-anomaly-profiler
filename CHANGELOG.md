# Changelog

All notable changes to this tool are recorded here. Rule ids are part of the
public surface: renaming one is a breaking change and is recorded as such.

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
