// @ts-check

/**
 * Every test is a dot: green passed, red failed, blue running (it pulses), a plain dot for finished-but-not-yet-known
 * (CI lane, until the results arrive), and a hollow dot while queued. Long suites wrap onto more rows; past `maxRows`
 * each dot stands for several tests and shows the worst of them.
 *
 * @typedef {'passed' | 'failed' | 'error' | 'running' | 'done' | 'queued'} DotState
 */

/** Worst first: what a bucket of several tests shows. */
const RANK = ['failed', 'error', 'running', 'queued', 'done', 'passed']

/**
 * @param {DotState[]} states
 * @param {{ columns: number, reserve?: number, maxRows?: number, tick?: number, g: import('./symbols.mjs').Glyphs, style: import('./style.mjs').Style }} opts
 *   reserve: columns kept free on the row (indent and the count summary)
 * @returns {{ rows: string[], perDot: number }}
 */
export function dotStrip(states, opts) {
  const perRow = Math.max(4, Math.floor((opts.columns - (opts.reserve ?? 0)) / 2))
  const maxRows = opts.maxRows ?? 3
  let cells = states
  let perDot = 1
  if (states.length > perRow * maxRows) {
    perDot = Math.ceil(states.length / (perRow * maxRows))
    cells = []
    for (let i = 0; i < states.length; i += perDot) {
      const bucket = states.slice(i, i + perDot)
      cells.push(/** @type {DotState} */ (RANK.find((s) => bucket.includes(/** @type {DotState} */ (s))) ?? 'queued'))
    }
  }
  const { g, style } = opts
  const beat = (opts.tick ?? 0) % 2 === 0
  /** @param {DotState} s */
  const paint = (s) => (s === 'passed' ? style.ok(g.dot) : s === 'failed' || s === 'error' ? style.fail(g.dot) : s === 'running' ? style.accent(beat ? g.dot : g.small) : s === 'done' ? g.dot : style.muted(g.hollow))
  /** @type {string[]} */
  const rows = []
  for (let i = 0; i < cells.length; i += perRow) rows.push(cells.slice(i, i + perRow).map(paint).join(' '))
  return { rows, perDot }
}
