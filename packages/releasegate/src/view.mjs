// @ts-check
import { duration, ui as kui } from 'kadeep'

const { bigText, box, clock, createLive, dotStrip, pad, pulse, truncate, width, wrap } = kui

/**
 * The gate in a rich terminal (a laptop, never CI): a live checklist where each check shows its tests as dots, then
 * the verdict in large dots. Plain output, which CI sees, is produced by cli.mjs and is unchanged.
 *
 * @typedef {import('./policy.mjs').Check} Check
 * @typedef {import('./gate.mjs').GateEvent} GateEvent
 * @typedef {import('./gate.mjs').Report} Report
 * @typedef {'queued' | 'running' | 'passed' | 'failed' | 'error' | 'skipped'} RowState
 * @typedef {{ check: Check, state: RowState, total: number, done: number, finished: Map<string, { id: string, name: string, status: string }>, summary: string, started: number, ms: number, current: string }} Row
 */

/**
 * @param {import('kadeep').ui.UiContext} u
 * @param {Check[]} checks
 * @param {NodeJS.WritableStream} stdout
 */
export function gateView(u, checks, stdout) {
  const { term, style, g } = u
  /** @type {Row[]} */
  const rows = checks.map((check) => ({ check, state: 'queued', total: 0, done: 0, finished: new Map(), summary: '', started: 0, ms: 0, current: '' }))
  const nameW = Math.min(26, Math.max(8, ...checks.map((c) => width(c.name)))) + 2
  const live = createLive(term, { onInterrupt: () => term.stderr.write(`${style.muted('Stopped waiting. Runs already queued continue on KaDeep.')}\n`) })
  /** @param {string[]} lines */
  const print = (lines) => stdout.write(`${lines.join('\n')}\n`)

  /** @param {Row} r @param {number} tick */
  const icon = (r, tick) =>
    r.state === 'passed' ? style.ok(g.ok) : r.state === 'failed' ? style.fail(g.fail) : r.state === 'error' ? style.warn(g.warn) : r.state === 'running' ? style.accent(tick % 2 ? g.small : g.dot) : style.muted(g.hollow)

  /** @param {Row} r @param {number} tick */
  const line = (r, tick) => {
    const head = `  ${icon(r, tick)} ${pad(truncate(r.check.name, nameW - 2), nameW)}`
    if (r.state === 'queued' || r.state === 'skipped') return `${head}${style.muted(r.state)}`
    if (r.check.type === 'localization') return `${head}${r.state === 'running' ? style.muted('checking the localization gate') : r.state === 'passed' ? r.summary : style.muted(r.summary)}`
    /** @type {Array<'passed' | 'failed' | 'running' | 'done' | 'queued'>} */
    const states = [...r.finished.values()].map((x) => (x.status === 'passed' ? 'passed' : 'failed'))
    for (let i = states.length; i < r.done; i++) states.push('done')
    if (r.state === 'running' && states.length < r.total) states.push('running')
    while (states.length < r.total) states.push('queued')
    const dots = states.length ? dotStrip(states, { columns: 44, maxRows: 1, tick, g, style }).rows[0] : ''
    // One dot column for every row, so counts and times line up.
    const dotsW = Math.min(43, Math.max(1, ...rows.map((x) => x.total * 2 - 1)))
    const counts = r.total ? `${Math.max(r.done, r.finished.size)}/${r.total}` : ''
    const time = r.state === 'running' ? clock(Date.now() - r.started) : duration(r.ms)
    return `${head}${pad(dots, dotsW)}   ${style.muted(pad(counts, 7))} ${style.muted(time)}`
  }

  return {
    start() {
      live.start((tick) => {
        const lines = rows.map((r) => line(r, tick))
        const running = rows.find((r) => r.state === 'running')
        if (running?.current) lines.push(`    ${style.muted(`${pulse(g)[tick % 4]}  ${truncate(running.current, term.columns - 14)}`)}`)
        return lines
      })
    },

    /** @param {GateEvent} e */
    event(e) {
      const r = rows.find((x) => x.check === e.check)
      if (!r) return
      if (e.type === 'start') {
        r.state = 'running'
        r.started = Date.now()
        if (e.check.type === 'tests') r.total = e.check.tests?.length ?? 0
      } else if (e.type === 'progress') {
        const p = e.progress
        if (e.check.type === 'suite' && p?.total) r.total = p.total
        if (e.check.type === 'suite' && typeof p?.done === 'number') r.done = Math.max(r.done, p.done)
        if (p?.current) r.current = p.current
        for (const f of p?.finished ?? []) r.finished.set(f.id, f)
        if (e.check.type === 'tests') r.done = r.finished.size
      } else {
        r.state = e.result.status
        r.summary = e.result.summary
        r.ms = e.result.durationMs
        for (const x of e.result.runs ?? []) r.finished.set(x.id, x)
        r.total = Math.max(r.total, e.result.total ?? 0, r.finished.size)
        r.done = r.finished.size
        r.current = ''
      }
      live.update()
    },

    /** @param {Report} report @param {string | undefined} reportPath */
    finish(report, reportPath) {
      report.checks.forEach((c, i) => {
        if (rows[i] && rows[i].state === 'queued') rows[i].state = c.status
      })
      if (live.active) {
        live.update()
        live.stop({ keep: true })
      }
      const failing = report.checks.flatMap((c) => (c.runs ?? []).filter((x) => x.status !== 'passed').map((x) => ({ check: c.name, ...x })))
      // Each failure: the test and its verdict, then why, word-wrapped under it (never cut mid-word by the terminal).
      if (failing.length)
        print([
          '',
          ...failing.flatMap((f) => [
            truncate(`  ${style.fail(g.fail)} ${style.bold(f.name)}${f.verdict && f.verdict !== 'PASS' ? `  ${style.fail(f.verdict)}` : ''}`, term.columns - 1),
            ...(f.error ? wrap(String(f.error), term.columns - 1, { indent: '    ', maxLines: 3 }).map((l) => style.muted(l)) : [])
          ])
        ])

      const shadow = report.mode === 'shadow'
      const paint = report.verdict === 'GO' ? style.ok : shadow ? style.warn : style.fail
      if (report.verdict === 'ERROR') print(['', ...box(String(report.error ?? 'The gate could not evaluate.').split('\n'), { columns: term.columns, g, title: shadow ? 'ERROR · shadow mode, not blocking' : 'ERROR', border: paint })])
      else print(['', ...bigText(report.verdict, g).map((l) => `  ${paint(l)}`)])

      const required = report.checks.filter((c) => c.required)
      const passed = required.filter((c) => c.status === 'passed').length
      const bits = [
        report.checks.length ? `${passed} of ${required.length} required check${required.length === 1 ? '' : 's'} passed` : '',
        duration(report.durationMs),
        shadow && report.verdict !== 'GO' ? style.warn('shadow mode: not blocking') : '',
        reportPath ? style.muted(`report: ${reportPath}`) : ''
      ].filter(Boolean)
      print(['', `  ${bits.join(style.muted(' · '))}`, ''])
    }
  }
}

/**
 * The gate's context line (project · commit · mode · API) for a terminal `max` columns wide: parts are kept whole and
 * the line breaks between them.
 * @param {string[]} parts
 * @param {number} max
 */
export function metaLines(parts, max) {
  /** @type {string[]} */
  const lines = []
  let line = ''
  for (const part of parts) {
    if (line && width(`${line} · ${part}`) <= max) line = `${line} · ${part}`
    else {
      if (line) lines.push(line)
      if (width(part) <= max) line = part
      else {
        const pieces = wrap(part, max)
        lines.push(...pieces.slice(0, -1))
        line = pieces[pieces.length - 1] ?? ''
      }
    }
  }
  if (line) lines.push(line)
  return lines
}
