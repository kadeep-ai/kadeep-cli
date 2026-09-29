// @ts-check
import { duration } from '../output.mjs'
import { truncate, wrap } from '../ui/style.mjs'

/**
 * One record in full: a run step by step, a test case, a suite run, an issue. The one-shot commands (`kadeep runs
 * show …`) and the interactive session print the same views. Plain output is exactly what 0.2 printed; rich output
 * is word-wrapped to the terminal so long summaries never break mid-word.
 *
 * @typedef {import('../output.mjs').Output} Output
 */

/** @param {string | undefined} iso */
export const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '')

/** "3m ago", "2h ago", "5d ago" for picker hints. @param {string | undefined} iso */
export function ago(iso) {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

/** @param {Output} out */
const columns = (out) => Math.max(20, out.ui.term.stdout.columns || out.ui.term.columns) - 1

/**
 * Each text once: the server often repeats the summary as the error.
 * @returns {(t: unknown) => boolean}
 */
function freshTexts() {
  /** @type {Set<string>} */
  const said = new Set()
  return (t) => {
    const k = String(t ?? '').trim()
    if (!k || said.has(k)) return false
    said.add(k)
    return true
  }
}

/** A run step by step (`kadeep runs show`). @param {Output} out @param {any} r */
export function printRun(out, r) {
  const fresh = freshTexts()
  if (out.rich) {
    const { style, g } = out.ui
    const cols = columns(out)
    out.line(truncate(`${out.mark(r.status)} ${style.bold(r.test)}  ${out.status(r.status)}${r.verdict && r.verdict !== 'PASS' ? `  ${style.fail(r.verdict)}` : ''}  ${style.muted(`${duration(r.durationMs)} · ${r.id}`)}`, cols))
    if (fresh(r.summary)) out.lines(wrap(r.summary, cols, { indent: '  ' }))
    if (fresh(r.error)) out.lines(wrap(r.error, cols, { indent: '  ' }).map((l) => style.fail(l)))
    if (fresh(r.verdictReason)) out.lines(wrap(r.verdictReason, cols, { indent: '  ' }).map((l) => style.muted(l)))
    if (r.steps.length) out.line()
    r.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
      out.line(truncate(`  ${s.ok ? style.ok(g.dot) : style.fail(g.dot)} ${style.muted(String(s.n).padStart(2))}  ${style.accent(s.tool)}${s.target ? ` ${s.target}` : ''}${s.result ? style.muted(`  ${String(s.result).split('\n')[0]}`) : ''}`, cols))
      if (i < r.steps.length - 1) out.line(`  ${style.muted(g.v)}`)
    })
    if (r.report) out.line(style.muted(`\n  report: ${r.report}`))
    return
  }
  out.line(`${out.mark(r.status)} ${out.c.bold(r.test)}  ${r.status}${r.verdict && r.verdict !== 'PASS' ? ` [${r.verdict}]` : ''}  ${duration(r.durationMs)}  ${out.c.dim(r.id)}`)
  if (fresh(r.summary)) out.line(String(r.summary))
  if (fresh(r.error)) out.line(out.c.red(String(r.error)))
  if (fresh(r.verdictReason)) out.line(out.c.dim(String(r.verdictReason)))
  if (r.steps.length) out.line()
  for (const s of r.steps) out.line(`  ${String(s.n).padStart(3)}. ${s.ok ? out.c.green('ok  ') : out.c.red('FAIL')} ${s.tool}${s.target ? ` ${s.target}` : ''}${s.result ? out.c.dim(` · ${String(s.result).slice(0, 160)}`) : ''}`)
  if (r.report) out.line(out.c.dim(`\nreport: ${r.report}`))
}

/** A test case (`kadeep tests show`). @param {Output} out @param {any} t */
export function printTest(out, t) {
  if (out.rich) {
    const { style } = out.ui
    const cols = columns(out)
    out.line(truncate(`${style.bold(t.name)}  ${style.muted(t.key)}${t.priority ? `  ${t.priority}` : ''}${t.labels.length ? style.muted(`  [${t.labels.join(', ')}]`) : ''}`, cols))
    if (t.description) out.lines(wrap(t.description, cols).map((l) => style.muted(l)))
    if (t.instructions) {
      out.line()
      out.lines(wrap(t.instructions, cols))
    }
    if (t.steps?.length) {
      out.line()
      t.steps.forEach((/** @type {string} */ s, /** @type {number} */ i) => out.lines(wrap(s, cols, { first: `  ${style.muted(`${i + 1}.`)} `, indent: ' '.repeat(String(i + 1).length + 4) })))
    }
    if (t.expected) {
      out.line()
      out.lines(wrap(t.expected, cols, { first: `${style.bold('Expected')}  `, indent: '  ' }))
    }
    out.line(style.muted(`\nlast run: ${t.lastRunStatus ?? 'never'}${t.lastRunId ? ` (${t.lastRunId})` : ''}`))
    return
  }
  out.line(`${out.c.bold(t.name)}  ${out.c.dim(t.key)}${t.priority ? `  ${t.priority}` : ''}${t.labels.length ? `  [${t.labels.join(', ')}]` : ''}`)
  if (t.description) out.line(t.description)
  out.line()
  out.line(t.instructions ?? '')
  if (t.steps?.length) {
    out.line()
    t.steps.forEach((/** @type {string} */ s, /** @type {number} */ i) => out.line(`  ${i + 1}. ${s}`))
  }
  if (t.expected) out.line(`\nExpected: ${t.expected}`)
  out.line(out.c.dim(`\nlast run: ${t.lastRunStatus ?? 'never'}${t.lastRunId ? ` (${t.lastRunId})` : ''}`))
}

/** A suite run's results (`kadeep suite-runs show`). @param {Output} out @param {any} sr */
export function printSuiteRun(out, sr) {
  if (out.rich) {
    const { style } = out.ui
    const cols = columns(out)
    out.line(truncate(`${out.mark(sr.status)} ${style.bold(sr.suite)}  ${sr.passed} passed, ${sr.failed} failed  ${style.muted(sr.id)}`, cols))
    for (const r of sr.runs ?? []) out.line(truncate(`  ${out.mark(r.status)} ${r.name}${r.verdict && r.verdict !== 'PASS' ? `  ${style.fail(r.verdict)}` : ''}${r.error ? style.muted(`  ${String(r.error).split('\n')[0]}`) : ''}`, cols))
    return
  }
  out.line(`${out.mark(sr.status)} ${out.c.bold(sr.suite)}  ${sr.passed} passed, ${sr.failed} failed  ${out.c.dim(sr.id)}`)
  for (const r of sr.runs ?? []) out.line(`  ${out.mark(r.status)} ${r.name}${r.verdict && r.verdict !== 'PASS' ? ` [${r.verdict}]` : ''}${r.error ? out.c.dim(` · ${r.error}`) : ''}  ${out.c.dim(r.id)}`)
}

/** An issue (the session's issue screen). @param {Output} out @param {any} i */
export function printIssue(out, i) {
  const { style, g } = out.ui
  const cols = columns(out)
  const sev = i.severity === 'critical' ? style.fail(i.severity) : i.severity === 'major' ? style.warn(i.severity) : style.muted(i.severity)
  out.lines(wrap(i.title, cols, { first: `${style.warn(g.warn)} `, indent: '  ' }))
  out.line(truncate(`  ${sev} ${style.muted('·')} ${i.status}${i.type ? ` ${style.muted('·')} ${i.type}` : ''}${i.createdAt ? style.muted(` · ${ago(i.createdAt)}`) : ''}  ${style.muted(i.id)}`, cols))
  if (i.ticket) out.line(style.muted(`  ticket: ${i.ticket}`))
}

/** The last line of a list in a rich terminal: how to open one, so nobody has to guess `show`. @param {Output} out @param {string} how */
export function openHint(out, how) {
  if (out.rich) out.line(out.ui.style.muted(`\n${out.ui.g.small} open one: ${how}  ·  or run kadeep and pick it from the list`))
}
