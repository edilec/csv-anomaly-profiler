/**
 * The two robust methods this tool offers, and nothing else.
 *
 * Both are order statistics: they need the values sorted and they need enough
 * of them. Neither is a test of significance and neither says a point is wrong
 * -- a point outside a fence is a point outside a fence, and what to do about
 * it is a question about the data that this tool cannot answer.
 *
 * The quantile definition is the linear interpolation between the closest
 * ranks that R calls type 7 and NumPy calls `linear`. It is named here because
 * different definitions put a fence in different places, and a reader comparing
 * this output with another tool needs to know which one produced it.
 */

/** The constant that makes the median absolute deviation a consistent estimator. */
export const MAD_CONSTANT = 0.6745

/** Ascending numeric order. These are numbers, so the comparison is numeric. */
export function sortedCopy(values) {
  return [...values].sort((a, b) => a - b)
}

export function median(sorted) {
  if (sorted.length === 0) return null
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  return (sorted[middle - 1] + sorted[middle]) / 2
}

/** Type 7: linear interpolation between the closest ranks. */
export function quantile(sorted, probability) {
  if (sorted.length === 0) return null
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (position - lower) * (sorted[upper] - sorted[lower])
}

export function medianAbsoluteDeviation(sorted, centre) {
  if (sorted.length === 0) return null
  return median(sortedCopy(sorted.map((value) => Math.abs(value - centre))))
}

/**
 * The modified z-score.
 *
 * The caller must have established that the deviation is not zero. Dividing by
 * a zero deviation yields Infinity for every value that is not the median,
 * which would report a column of mostly identical values as almost entirely
 * outlying -- a confident answer produced by a division, not by evidence.
 */
export function modifiedZScore(value, centre, deviation) {
  return (MAD_CONSTANT * (value - centre)) / deviation
}
