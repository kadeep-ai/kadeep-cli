// @ts-check

/**
 * Terminal output. With `--json`, stdout carries exactly one JSON document (the result, or `{ ok: false, error, code }`)
 * and nothing else; progress goes to stderr either way, so agents can parse stdout blindly.
 * @param {{ json?: boolean, color?: boolean, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream }} opts
 */
export function createOutput({ json = false, color, stdout = process.stdout, stderr = process.stderr } = {}) {
  const useColor = color ?? (Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb')
  /** @param {string} code */
  const paint = (code) => (/** @type {unknown} */ s) => (useColor ? `\u001b[${code}m${s}\u001b[0m` : String(s))
  const c = { green: paint('32'), red: paint('31'), yellow: paint('33'), dim: paint('2'), bold: paint('1'), cyan: paint('36') }
  const out = {
    json,
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
    /** Progress and notes: stderr, so stdout stays machine-readable. @param {string} line */
    note(line) {
      stderr.write(`${line}\n`)
    },
    /** @param {string} line */
    warn(line) {
      stderr.write(`${c.yellow('!')} ${line}\n`)
    },
    /** @param {{ message: string, code?: string, details?: unknown }} err */
    error(err) {
      if (json) stdout.write(`${JSON.stringify({ ok: false, error: err.message, code: err.code ?? 'error', ...(err.details && typeof err.details === 'object' ? { details: err.details } : {}) }, null, 2)}\n`)
      else stderr.write(`${c.red('✗')} ${err.message}\n`)
    },
    /** @param {string} status */
    mark(status) {
      return status === 'passed' ? c.green('✓') : status === 'queued' || status === 'running' ? c.dim('…') : c.red('✗')
    },
    /**
     * A padded table; the last column takes what is left of the terminal width.
     * @param {string[]} headers
     * @param {Array<Array<unknown>>} rows
     */
    table(headers, rows) {
      if (json) return
      if (!rows.length) return
      const cells = [headers, ...rows.map((r) => r.map((v) => (v === undefined || v === null ? '' : String(v))))]
      const widths = headers.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? '').length)))
      const max = stdout.columns || 120
      const lastStart = widths.slice(0, -1).reduce((t, w) => t + w + 2, 0)
      const lastWidth = Math.max(10, max - lastStart)
      cells.forEach((r, ri) => {
        const text = r.map((v, i) => (i === r.length - 1 ? (v.length > lastWidth ? `${v.slice(0, lastWidth - 1)}…` : v) : v.padEnd(widths[i]))).join('  ')
        stdout.write(`${ri === 0 ? c.dim(text) : text}\n`)
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
