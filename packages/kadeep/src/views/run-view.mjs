// @ts-check
import { duration } from '../output.mjs'
import { box, clock, createLive, dotStrip, pad, pulse, truncate, width } from '../ui/index.mjs'

/**
 * @typedef {import('../ops/run.mjs').RunResult} RunResult
 * @typedef {import('../ops/run.mjs').RunTestsResult} RunTestsResult
 * @typedef {import('../ops/run.mjs').Progress} Progress
 * @typedef {{ progress: (p: Progress) => void, done: (r: RunTestsResult, junitFile?: string) => void }} RunView
 */

/** @param {unknown} s */
const firstLine = (s) => String(s ?? '').split('\n')[0]

/**
 * Plain output, exactly as 0.1 printed it (scripts and tests match these lines).
 * @param {import('../output.mjs').Output} out
 * @param {RunTestsResult} r
 * @param {string} [junitFile]
 */
export function printRunResult(out, r, junitFile) {
  if (r.status === 'queued') {
    out.line(r.jobs.length ? `Queued: ${r.jobs.join(', ')}. Follow with: kadeep jobs show ${r.jobs[0]} --wait` : 'Started (this KaDeep server runs jobs inline). Check `kadeep runs` for the result.')
    return
  }
  for (const x of r.runs) out.line(`${out.mark(x.status)} ${x.name}${x.verdict && x.verdict !== 'PASS' ? ` [${x.verdict}]` : ''}${x.error ? ` — ${x.error}` : ''}`)
  if (r.error) out.line(out.c.red(r.error))
  if (junitFile) out.line(out.c.dim(`JUnit written to ${junitFile}`))
  out.line(`${r.passed}/${r.total} passed in ${duration(r.durationMs)}${r.suiteRunId ? out.c.dim(`  (suite run ${r.suiteRunId})`) : ''}`)
}

/**
 * The view of a run while it runs and when it ends.
 *
 * Rich terminals: every test is a dot (green passed, red failed, a pulsing blue dot for the one running, hollow while
 * queued), a line for the test in progress with a timer, each failure the moment it is known, and a summary box.
 * Everywhere else: one progress line per real change on stderr, then the plain result.
 *
 * @param {import('../output.mjs').Output} out
 * @param {{ title: string, total?: number }} opts  `total` when the number of tests is known up front (`--test` runs)
 * @returns {RunView}
 */
export function runView(out, opts) {
  if (!out.rich) {
    let last = ''
    return {
      progress(p) {
        if (p.message === last) return
        last = p.message
        if (!out.json || process.stderr.isTTY) out.note(out.c.dim(`  ${p.message}`))
      },
      done(r, junitFile) {
        out.result(r, () => printRunResult(out, r, junitFile))
      }
    }
  }

  const { term, style, g } = out.ui
  const started = Date.now()
  const fixedTotal = opts.total ?? 0
  let total = fixedTotal
  let done = 0
  let current = ''
  let jobId = ''
  /** @type {Map<string, RunResult>} */
  const finished = new Map()
  /** @type {Set<string>} */
  const printed = new Set()
  const listAll = () => total > 0 && total <= 12

  /** @param {RunResult} r */
  const resultLine = (r) => {
    const ok = r.status === 'passed'
    const verdict = r.verdict && r.verdict !== 'PASS' ? `  ${style.fail(r.verdict)}` : ''
    const detail = ok ? style.muted(`  ${duration(r.durationMs)}`) : r.error || r.summary ? `  ${style.muted(firstLine(r.error || r.summary))}` : ''
    return `  ${ok ? style.ok(g.ok) : style.fail(g.fail)} ${r.name}${verdict}${detail}`
  }

  /** @param {Array<'passed' | 'failed' | 'running' | 'done' | 'queued'>} states @param {number} tick */
  const strip = (states, tick) => {
    const failed = [...finished.values()].filter((r) => r.status !== 'passed').length
    const counts = `${style.muted(`${Math.max(done, finished.size)}/${total}`)}${failed ? `${style.muted(' · ')}${style.fail(`${failed} failed`)}` : ''}`
    const { rows, perDot } = dotStrip(states, { columns: term.columns, reserve: 26, tick, g, style })
    return rows.map((row, i) => `  ${row}${i === rows.length - 1 ? `   ${counts}${perDot > 1 ? style.muted(` · 1 dot = ${perDot} tests`) : ''}` : ''}`)
  }

  const live = createLive(term, {
    onInterrupt: () => term.stderr.write(`${style.muted('Stopped waiting. The run continues on KaDeep:')} kadeep jobs show ${jobId || '<job id>'} --wait\n`)
  })
  out.line(`${style.accent(g.dot)} ${style.bold('KaDeep')} ${style.muted('·')} ${opts.title}`)
  live.start((tick) => {
    const lines = []
    if (total) {
      /** @type {Array<'passed' | 'failed' | 'running' | 'done' | 'queued'>} */
      const states = [...finished.values()].map((r) => (r.status === 'passed' ? 'passed' : 'failed'))
      for (let i = states.length; i < done; i++) states.push('done')
      if (states.length < total) states.push('running')
      while (states.length < total) states.push('queued')
      lines.push(...strip(states, tick))
    }
    const label = current || (total ? 'Waiting for the next test' : 'Starting')
    const time = clock(Date.now() - started)
    const room = Math.max(10, term.columns - 12 - width(time))
    lines.push(`  ${style.accent(pulse(g)[tick % 4])}  ${pad(truncate(label, room), room)} ${style.muted(time)}`)
    return lines
  })

  return {
    progress(p) {
      if (p.job?.id) jobId = p.job.id
      if (!fixedTotal && typeof p.total === 'number' && p.total > 0) total = p.total
      if (!fixedTotal && typeof p.done === 'number') done = Math.max(done, p.done)
      if (p.current) current = p.current
      for (const r of p.finished ?? []) {
        if (finished.has(r.id)) continue
        finished.set(r.id, r)
        if (fixedTotal) done = finished.size
        if (r.status !== 'passed' || listAll()) {
          printed.add(r.id)
          live.print([resultLine(r)])
        }
      }
      live.update()
    },

    done(r, junitFile) {
      live.stop({ keep: false })
      if (r.status === 'queued') {
        out.lines(box([`${style.muted(g.hollow)} Queued ${r.jobs.join(', ') || '(this server runs jobs inline)'}`, style.muted(r.jobs.length ? `Follow it: kadeep jobs show ${r.jobs[0]} --wait` : 'Check `kadeep runs` for the result.')], { columns: term.columns, g, border: style.muted }))
        return
      }
      for (const x of r.runs) finished.set(x.id, x)
      total = Math.max(total, r.total)
      done = r.runs.length
      if (r.runs.length) out.lines(strip(r.runs.map((x) => (x.status === 'passed' ? 'passed' : 'failed')), 0))
      out.lines(r.runs.filter((x) => !printed.has(x.id) && (x.status !== 'passed' || r.runs.length <= 12)).map(resultLine))
      if (junitFile) out.line(style.muted(`  JUnit written to ${junitFile}`))
      const paint = r.status === 'passed' ? style.ok : r.status === 'failed' ? style.fail : style.warn
      const mark = r.status === 'passed' ? g.ok : r.status === 'timeout' ? g.warn : g.fail
      const text =
        r.status === 'timeout'
          ? `${mark} Still running after the timeout · kadeep jobs show ${r.jobs[0] ?? '<job id>'} --wait`
          : r.status === 'error' && !r.total
            ? `${mark} ${firstLine(r.error)}`
            : `${mark} ${r.passed}/${r.total} passed · ${duration(r.durationMs)}${r.suiteRunId ? ` · suite run ${r.suiteRunId}` : ''}`
      out.lines(box([paint(text)], { columns: term.columns, g, border: paint }))
      if (r.status === 'error' && r.total && r.error) out.line(style.warn(`  ${firstLine(r.error)}`))
    }
  }
}
