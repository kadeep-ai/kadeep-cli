// @ts-check
import { EXIT, KadeepError, locValidate, runTests, VERSION as KADEEP_VERSION } from 'kadeep'
import { VERSION } from './version.mjs'

/**
 * The gate: run each check in the policy through kadeep, then decide.
 *   GO     every required check passed
 *   NO-GO  a required check failed or errored
 *   ERROR  the gate could not evaluate (bad policy, no or wrong CI token, KaDeep unreachable)
 * Shadow mode reports the same verdict but never blocks.
 *
 * @typedef {import('./policy.mjs').Policy} Policy
 * @typedef {import('./policy.mjs').Check} Check
 * @typedef {{
 *   name: string,
 *   type: Check['type'],
 *   required: boolean,
 *   status: 'passed' | 'failed' | 'error' | 'skipped',
 *   summary: string,
 *   durationMs: number,
 *   target?: string,
 *   passed?: number,
 *   failed?: number,
 *   total?: number,
 *   suiteRunId?: string,
 *   jobs?: string[],
 *   runs?: Array<{ id: string, name: string, status: string, verdict?: string, durationMs?: number, error?: string, summary?: string, report?: string }>,
 *   locales?: string[],
 *   failures?: string[],
 *   error?: string
 * }} CheckResult
 * @typedef {{
 *   tool: 'KaDeep Release Gate',
 *   version: string,
 *   kadeep: string,
 *   verdict: 'GO' | 'NO-GO' | 'ERROR',
 *   mode: 'enforce' | 'shadow',
 *   blocking: boolean,
 *   project?: string,
 *   api: string,
 *   commit: import('kadeep').CiContext,
 *   policy?: string,
 *   startedAt: string,
 *   finishedAt: string,
 *   durationMs: number,
 *   checks: CheckResult[],
 *   error?: string,
 *   errorExit?: number
 * }} Report
 * @typedef {{ type: 'start', check: Check } | { type: 'progress', check: Check, message: string } | { type: 'done', check: Check, result: CheckResult }} GateEvent
 */

/** Errors after which no further check can work: the token or KaDeep itself. */
const FATAL = new Set(['auth_invalid', 'auth_required', 'ci_token_required', 'network', 'timeout', 'rate_limited'])

/**
 * @param {import('kadeep').Client} client
 * @param {string} project
 * @param {Check} check
 * @param {(e: GateEvent) => void} emit
 * @returns {Promise<CheckResult>}
 */
async function runCheck(client, project, check, emit) {
  const started = Date.now()
  const base = { name: check.name, type: check.type, required: check.required }
  if (check.type === 'localization') {
    const rule = check.localization ?? { requireApproved: true }
    const v = await locValidate(client, { project, locales: rule.locales, minCoverage: rule.minCoverage, minMqm: rule.minMqm, allowUnapproved: !rule.requireApproved })
    return { ...base, status: v.ok ? 'passed' : 'failed', summary: v.ok ? `${v.locales.join(', ') || 'all locales'} ready` : v.failures.join('; '), durationMs: Date.now() - started, locales: v.locales, failures: v.failures }
  }
  const r = await runTests(client, { project, suite: check.suite, tests: check.tests, browser: check.browser, viewport: check.viewport, timeoutMs: check.timeoutMinutes * 60_000, onProgress: (p) => emit({ type: 'progress', check, message: p.message }) })
  const status = r.ok ? 'passed' : r.status === 'failed' ? 'failed' : 'error'
  const counts = `${r.passed}/${r.total} passed`
  return { ...base, status, summary: r.error ? (r.total ? `${counts}; ${r.error}` : r.error) : counts, durationMs: Date.now() - started, target: r.target, passed: r.passed, failed: r.failed, total: r.total, suiteRunId: r.suiteRunId, jobs: r.jobs, runs: r.runs, ...(r.error ? { error: r.error } : {}) }
}

/**
 * @param {{ policy: Policy, mode: 'enforce' | 'shadow', project: string, api: string, client: import('kadeep').Client, commit: import('kadeep').CiContext, onEvent?: (e: GateEvent) => void }} input
 * @returns {Promise<Report>}
 */
export async function runGate({ policy, mode, project, api, client, commit, onEvent = () => undefined }) {
  const started = Date.now()
  /** @type {CheckResult[]} */
  const checks = []
  /** @type {KadeepError | undefined} */
  let fatal
  for (const check of policy.checks) {
    if (fatal) {
      checks.push({ name: check.name, type: check.type, required: check.required, status: 'skipped', summary: 'not run: the gate stopped early', durationMs: 0 })
      continue
    }
    onEvent({ type: 'start', check })
    /** @type {CheckResult} */
    let result
    try {
      result = await runCheck(client, project, check, onEvent)
    } catch (err) {
      const e = err instanceof KadeepError ? err : new KadeepError(/** @type {Error} */ (err)?.message ?? String(err))
      if (FATAL.has(e.code)) fatal = e
      result = { name: check.name, type: check.type, required: check.required, status: 'error', summary: e.message, durationMs: 0, error: e.message }
    }
    checks.push(result)
    onEvent({ type: 'done', check, result })
  }
  const required = checks.filter((c) => c.required)
  /** @type {Report['verdict']} */
  const verdict = fatal ? 'ERROR' : required.every((c) => c.status === 'passed') ? 'GO' : 'NO-GO'
  return {
    tool: 'KaDeep Release Gate',
    version: VERSION,
    kadeep: KADEEP_VERSION,
    verdict,
    mode,
    blocking: mode === 'enforce' && verdict !== 'GO',
    project,
    api,
    commit,
    policy: policy.file,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    checks,
    ...(fatal ? { error: fatal.message, errorExit: fatal.exitCode === EXIT.NETWORK ? EXIT.NETWORK : EXIT.USAGE } : {})
  }
}

/**
 * A report for a gate that never ran its checks (bad policy, missing token): still written, so CI shows why.
 * @param {{ mode: 'enforce' | 'shadow', api: string, commit: import('kadeep').CiContext, error: string, project?: string, policy?: string, errorExit?: number }} input
 * @returns {Report}
 */
export function errorReport({ mode, api, commit, error, project, policy, errorExit = EXIT.USAGE }) {
  const now = new Date().toISOString()
  return { tool: 'KaDeep Release Gate', version: VERSION, kadeep: KADEEP_VERSION, verdict: 'ERROR', mode, blocking: mode === 'enforce', project, api, commit, policy, startedAt: now, finishedAt: now, durationMs: 0, checks: [], error, errorExit }
}

/** Exit code: shadow never blocks; enforce is 0 GO, 1 NO-GO, 2 bad setup, 3 KaDeep unreachable. @param {Report} report */
export function exitCode(report) {
  if (report.mode === 'shadow' || report.verdict === 'GO') return EXIT.OK
  return report.verdict === 'NO-GO' ? EXIT.FAILED : report.errorExit ?? EXIT.USAGE
}
