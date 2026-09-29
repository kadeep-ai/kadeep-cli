// @ts-check
import { createUi } from './ui/index.mjs'
import { pad, truncate, width } from './ui/style.mjs'

/**
 * Terminal output for commands, on top of the UI layer (`./ui`), which decides once whether the terminal is rich,
 * plain or JSON.
 *
 * - With `--json`, stdout carries exactly one JSON document (the result, or `{ ok: false, error, code }`) and nothing
 *   else, so agents can parse stdout blindly.
 * - Plain mode (pipes, CI, TERM=dumb) prints exactly what 0.1 printed: no escape sequences unless FORCE_COLOR.
 * - Rich mode adds color, KaDeep's dots and live views. Progress always goes to stderr.
 *
 * @param {{ json?: boolean, noColor?: boolean, accent?: 'testing' | 'loc', env?: NodeJS.ProcessEnv, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream }} [opts]
 */
export function createOutput(opts = {}) {
  const ui = createUi(opts)
  const { term, style, g } = ui
  const json = term.mode === 'json'
  const { stdout, stderr } = term
  const c = { green: style.ok, red: style.fail, yellow: style.warn, dim: style.dim, bold: style.bold, cyan: style.accent, accent: style.accent, muted: style.muted }
  const out = {
    json,
    ui,
    rich: ui.rich,
    c,
    /** A command's result: JSON on --json, otherwise whatever `human` prints. @param {unknown} data @param {() => void} [human] */
    result(data, human) {
      if (json) stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else if (human) human()
    },
    /** @param {string} [line] */
    line(line = '') {
      if (!json) stdout.write(`${line}\n`)
    },
    /** @param {string[]} lines */
    lines(lines) {
      if (!json && lines.length) stdout.write(`${lines.join('\n')}\n`)
    },
    /** Progress and notes: stderr, so stdout stays machine-readable. @param {string} line */
    note(line) {
      stderr.write(`${line}\n`)
    },
    /** @param {string} line */
    warn(line) {
      stderr.write(`${c.yellow(ui.rich ? g.warn : '!')} ${line}\n`)
    },
    /** @param {{ message: string, code?: string, details?: unknown }} err */
    error(err) {
      if (json) stdout.write(`${JSON.stringify({ ok: false, error: err.message, code: err.code ?? 'error', ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}) }, null, 2)}\n`)
      else stderr.write(`${c.red(ui.rich ? g.fail : '✗')} ${err.message}\n`)
    },
    /** A result mark: ✔ / ✖ in rich mode, ✓ / ✗ as in 0.1 otherwise. @param {string} status */
    mark(status) {
      if (status === 'queued' || status === 'running' || status === 'pending') return c.muted(ui.rich ? g.hollow : '…')
      return status === 'passed' ? c.green(ui.rich ? g.ok : '✓') : c.red(ui.rich ? g.fail : '✗')
    },
    /** A status cell for tables: a colored dot and the word in rich mode, the word alone otherwise. @param {string | undefined} status */
    status(status) {
      if (!status) return ''
      if (!ui.rich) return status
      const dot = status === 'passed' ? c.green(g.dot) : status === 'failed' || status === 'error' || status === 'stopped' ? c.red(g.dot) : status === 'running' ? c.accent(g.dot) : c.muted(g.hollow)
      return `${dot} ${status}`
    },
    /**
     * A padded table (display width aware; cells may be colored); the last column takes what is left of the width.
     * @param {string[]} headers
     * @param {Array<Array<unknown>>} rows
     */
    table(headers, rows) {
      if (json || !rows.length) return
      const cells = [headers, ...rows.map((r) => r.map((v) => (v === undefined || v === null ? '' : String(v))))]
      const widths = headers.map((_, i) => Math.max(...cells.map((r) => width(r[i] ?? ''))))
      const max = stdout.columns || 120
      const lastStart = widths.slice(0, -1).reduce((t, w) => t + w + 2, 0)
      const lastWidth = Math.max(10, max - lastStart - 1)
      cells.forEach((r, ri) => {
        const text = r.map((v, i) => (i === r.length - 1 ? truncate(v, lastWidth) : pad(v, widths[i]))).join('  ')
        stdout.write(`${ri === 0 ? c.muted(text) : text}\n`)
      })
    }
  }
  return out
}

/** @typedef {ReturnType<typeof createOutput>} Output */

/** @param {number | undefined} ms */
export function duration(ms) {
  if (!ms || ms < 0) return '0s'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}
