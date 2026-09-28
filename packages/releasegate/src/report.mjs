// @ts-check
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { duration, junitXml } from 'kadeep'

/** @typedef {import('./gate.mjs').Report} Report */

const ICON = { passed: '✅', failed: '❌', error: '⚠️', skipped: '⏭️' }

/** @param {string} s */
const cell = (s) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

/** @param {Report} r */
export function verdictLine(r) {
  if (r.verdict === 'GO') return 'GO'
  return `${r.verdict}${r.mode === 'shadow' ? ' (shadow mode: not blocking)' : ''}`
}

/** @param {{ commit?: import('kadeep').CiContext }} r */
export function commitLine(r) {
  const c = r.commit
  if (!c) return ''
  return [c.commit ? `commit ${c.commit.slice(0, 7)}` : '', c.branch ? `on ${c.branch}` : '', c.pr ? `PR #${c.pr}` : ''].filter(Boolean).join(' ')
}

/**
 * The human report: what CI summaries and PR reviewers read.
 * @param {Report} r
 */
export function markdown(r) {
  const head = r.verdict === 'GO' ? '✅ GO' : r.verdict === 'NO-GO' ? (r.mode === 'shadow' ? '⚠️ NO-GO (shadow mode: not blocking)' : '❌ NO-GO') : r.mode === 'shadow' ? '⚠️ ERROR (shadow mode: not blocking)' : '❌ ERROR'
  const meta = [commitLine(r) ? commitLine(r).replace(/^commit (\w+)/, 'commit `$1`') : '', r.project ? `project \`${r.project}\`` : '', `mode ${r.mode}`, duration(r.durationMs)].filter(Boolean).join(' · ')
  const lines = [`## KaDeep Release Gate: ${head}`, '', meta, '']
  if (r.error) lines.push(`> ${r.error.replace(/\n/g, '\n> ')}`, '')
  if (r.checks.length) {
    lines.push('| Check | Required | Result | Details |', '| --- | --- | --- | --- |')
    for (const c of r.checks) lines.push(`| ${cell(c.name)} | ${c.required ? 'yes' : 'advisory'} | ${ICON[c.status]} ${c.status} | ${cell(c.summary)} |`)
    lines.push('')
  }
  const failing = r.checks.flatMap((c) => (c.runs ?? []).filter((x) => x.status !== 'passed').map((x) => ({ check: c.name, ...x })))
  if (failing.length) {
    lines.push('<details><summary>Failing tests</summary>', '')
    for (const f of failing) lines.push(`- **${f.name}** (${f.check})${f.verdict ? ` \`${f.verdict}\`` : ''}${f.error ? `: ${f.error}` : ''}${f.summary ? `\n  ${f.summary}` : ''}${f.report ? `\n  report: ${f.report}` : ''}`)
    lines.push('', '</details>', '')
  }
  if (r.commit?.runUrl) lines.push(`[CI run](${r.commit.runUrl})`, '')
  lines.push(`<sub>KaDeep Release Gate ${r.version} · Engineering release confidence.</sub>`, '')
  return lines.join('\n')
}

/**
 * One JUnit suite per check, so CI test dashboards show the gate next to other tests.
 * @param {Report} r
 */
export function junit(r) {
  return junitXml(
    r.checks.map((c) => {
      if (c.type === 'localization') return { name: c.name, runs: [{ name: `Localization gate${c.locales?.length ? ` (${c.locales.join(', ')})` : ''}`, status: c.status === 'passed' ? 'passed' : 'failed', error: c.status === 'passed' ? undefined : c.summary, durationMs: c.durationMs }] }
      return { name: c.name, error: c.status === 'error' || c.status === 'skipped' ? c.summary : undefined, runs: c.runs ?? [] }
    })
  )
}

/**
 * Write report.json (+ report.md, junit.xml) into the report directory.
 * @param {Report} r
 * @param {{ dir: string, junit: boolean, markdown: boolean }} opts
 * @param {string} cwd
 */
export function writeReports(r, opts, cwd) {
  const dir = resolve(cwd, opts.dir)
  mkdirSync(dir, { recursive: true })
  /** @type {Record<string, string>} */
  const files = { json: join(dir, 'report.json') }
  writeFileSync(files.json, `${JSON.stringify(r, null, 2)}\n`)
  if (opts.markdown) writeFileSync((files.markdown = join(dir, 'report.md')), markdown(r))
  if (opts.junit && r.checks.length) writeFileSync((files.junit = join(dir, 'junit.xml')), junit(r))
  return files
}

/** GitHub Actions: the Markdown report on the run's summary page. @param {Report} r @param {NodeJS.ProcessEnv} env */
export function githubSummary(r, env) {
  if (!env.GITHUB_STEP_SUMMARY) return false
  try {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown(r)}\n`)
    return true
  } catch {
    return false
  }
}

/** @param {string} s */
const escapeData = (s) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

/**
 * GitHub Actions annotations for checks that did not pass: errors when they block, warnings in shadow mode or for
 * advisory checks.
 * @param {Report} r
 * @returns {string[]}
 */
export function annotations(r) {
  const out = []
  if (r.error) out.push(`::${r.mode === 'shadow' ? 'warning' : 'error'} title=KaDeep Release Gate::${escapeData(r.error)}`)
  for (const c of r.checks) {
    if (c.status === 'passed' || c.status === 'skipped') continue
    const level = r.mode === 'enforce' && c.required ? 'error' : 'warning'
    out.push(`::${level} title=KaDeep Release Gate: ${escapeData(c.name).replace(/[,:]/g, ' ')}::${escapeData(c.summary)}`)
  }
  if (r.mode === 'shadow' && r.verdict !== 'GO') out.push(`::warning title=KaDeep Release Gate::Would have blocked this change (${r.verdict}). Shadow mode reports only; set mode: enforce in the policy to block.`)
  return out
}
