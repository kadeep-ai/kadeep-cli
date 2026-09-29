// @ts-check
import { routes } from '../api.mjs'
import { EXIT, KadeepError, usage } from '../errors.mjs'
import { findSuite } from './browse.mjs'

/**
 * Running tests, one code path for the CLI, the MCP server and releasegate. Runs are jobs on KaDeep's queue: start
 * them, then poll. No request stays open while a suite runs, so a proxy that cuts idle requests (Cloudflare at about
 * 100 s) cannot end one, and a CI network blip only costs a retried poll.
 *
 *   login (session / KADEEP_TOKEN) → POST /api/projects/:p/{suites|flows}/:key/run, then GET /api/jobs/:id
 *   CI token                       → POST /api/ci/:p/run {async:true}, then GET /api/ci/:p/jobs/:id
 *
 * @typedef {import('../client.mjs').Client} Client
 * @typedef {{ id: string, name: string, status: string, verdict?: string, durationMs?: number, error?: string, summary?: string, report?: string }} RunResult
 * @typedef {{
 *   ok: boolean,
 *   status: 'passed' | 'failed' | 'error' | 'timeout' | 'queued',
 *   kind: 'suite' | 'tests',
 *   target: string,
 *   project: string,
 *   lane: 'session' | 'ci',
 *   suiteRunId?: string,
 *   passed: number,
 *   failed: number,
 *   total: number,
 *   runs: RunResult[],
 *   jobs: string[],
 *   durationMs: number,
 *   error?: string
 * }} RunTestsResult
 * @typedef {{
 *   job: any,
 *   message: string,
 *   done?: number,
 *   total?: number,
 *   current?: string,
 *   finished?: RunResult[]
 * }} Progress
 *   `message` is the one-line summary plain output prints. The rest drives live views: counts and the current test
 *   from the job's progress, and `finished`, tests that completed since the last event (as each finishes on the login
 *   lane, where the job's checkpoint names them; at the end on the CI lane).
 * @typedef {{
 *   project: string,
 *   suite?: string,
 *   tests?: string[],
 *   browser?: string,
 *   viewport?: string,
 *   wait?: boolean,
 *   timeoutMs?: number,
 *   onProgress?: (p: Progress) => void,
 *   signal?: AbortSignal
 * }} RunTestsOptions
 */

export const BROWSERS = ['chromium', 'chrome', 'msedge', 'firefox', 'webkit']
export const VIEWPORTS = ['desktop', 'laptop', 'tablet', 'mobile']

const JOB_DONE = new Set(['completed', 'failed', 'cancelled'])
const RUN_DONE = new Set(['passed', 'failed', 'cancelled', 'stopped'])
const MAX_POLL_ERRORS = 10
export const DEFAULT_RUN_TIMEOUT_MS = 30 * 60_000

const pollMs = () => Number(process.env.KADEEP_POLL_MS) || 3000

/** @param {number} ms @param {AbortSignal} [signal] */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new KadeepError('Cancelled', { code: 'cancelled' }))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new KadeepError('Cancelled', { code: 'cancelled' }))
    }, { once: true })
  })
}

/** @param {any} r @returns {RunResult} */
const fromRun = (r) => ({ id: r.id, name: r.flowName ?? r.name, status: r.status, verdict: r.verdict, durationMs: r.durationMs, error: r.error, summary: r.summary, report: r.reportPath ?? r.report })

/** @param {any} job */
export function progressText(job) {
  const p = job?.progress
  const counts = p && typeof p.total === 'number' && p.total > 0 ? ` · ${p.done}/${p.total}` : ''
  return `${job?.status ?? 'unknown'}${counts}${p?.message ? ` · ${p.message}` : ''}`
}

/** @param {any} job @param {string} message @param {RunResult[]} [finished] @returns {Progress} */
const progressOf = (job, message, finished) => ({ job, message, done: job?.progress?.done, total: job?.progress?.total, current: job?.progress?.message, ...(finished?.length ? { finished } : {}) })

/**
 * Poll a job until it is done or the deadline passes. Transient failures (KaDeep unreachable, 5xx, 524) are retried:
 * the job keeps running server-side whatever happens to this connection. With `resolveRun`, runs the job's checkpoint
 * lists as completed are read as they appear, so a live view can show each result as it lands.
 * @param {() => Promise<any>} fetchJob
 * @param {{ deadline: number, onProgress?: (p: Progress) => void, signal?: AbortSignal, resolveRun?: (id: string) => Promise<any> }} opts
 */
async function follow(fetchJob, { deadline, onProgress, signal, resolveRun }) {
  let last = ''
  let errors = 0
  /** @type {Set<string>} */
  const seen = new Set()
  for (;;) {
    /** @type {any} */
    let job
    try {
      job = await fetchJob()
      errors = 0
    } catch (err) {
      if (!(err instanceof KadeepError) || err.exitCode !== EXIT.NETWORK || ++errors > MAX_POLL_ERRORS) throw err
      await sleep(Math.min(pollMs() * errors, 30_000), signal)
      continue
    }
    const message = progressText(job)
    /** @type {RunResult[]} */
    const finished = []
    if (resolveRun && onProgress) {
      for (const id of job.checkpoint?.completedRunIds ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const run = await resolveRun(id).catch(() => null)
        if (run) finished.push(fromRun(run))
      }
    }
    if (message !== last || finished.length) {
      last = message
      onProgress?.(progressOf(job, message, finished))
    }
    if (job.done || JOB_DONE.has(job.status)) return job
    if (Date.now() > deadline) return { ...job, timedOut: true }
    await sleep(pollMs(), signal)
  }
}

/** @param {Client} client @returns {'session' | 'ci'} */
const laneOf = (client) => (client.auth.kind === 'ci' ? 'ci' : 'session')

/**
 * What a finished job produced: its runs (and suite run), in one shape for both lanes.
 * @param {Client} client
 * @param {string} project
 * @param {any} job
 * @returns {Promise<{ runs: RunResult[], suiteRunId?: string, target?: string, error?: string }>}
 */
async function collect(client, project, job) {
  const failure = job.status !== 'completed' ? job.error || job.note || `Job ${job.id} ended as ${job.status}` : undefined
  if (laneOf(client) === 'ci') {
    if (job.suiteRun) return { runs: (job.suiteRun.runs ?? []).map(fromRun), suiteRunId: job.suiteRun.id, target: job.suiteRun.suite, error: job.suiteRun.runs?.length ? undefined : failure }
    if (job.run) return { runs: [fromRun(job.run)], target: job.run.name }
    return { runs: [], error: failure ?? `Job ${job.id} finished without a result` }
  }
  if (job.result?.suiteRunId) {
    const r = await routes.suiteRunResults(client, project, job.result.suiteRunId)
    return { runs: (r.runs ?? []).map(fromRun), suiteRunId: r.id, target: r.suite, error: r.runs?.length ? undefined : failure }
  }
  if (job.result?.runId) {
    const run = await routes.run(client, job.result.runId)
    return { runs: [fromRun(run)], target: run.flowName }
  }
  return { runs: [], error: failure ?? `Job ${job.id} finished without a result` }
}

/**
 * @param {{ kind: 'suite' | 'tests', target: string, project: string, lane: 'session' | 'ci', jobs: string[], started: number, runs: RunResult[], suiteRunId?: string, error?: string, timedOut?: boolean }} r
 * @returns {RunTestsResult}
 */
function finish(r) {
  const failed = r.runs.filter((x) => x.status !== 'passed').length
  const passed = r.runs.length - failed
  let error = r.error
  if (!error && !r.timedOut && !r.runs.length) error = r.kind === 'suite' ? 'No tests ran: the suite has no test cases.' : 'No tests ran.'
  /** @type {RunTestsResult['status']} */
  const status = r.timedOut ? 'timeout' : error ? 'error' : failed ? 'failed' : 'passed'
  if (r.timedOut) error = `Still running after the timeout. Follow it with \`kadeep jobs show ${r.jobs[0] ?? '<job>'} --wait\`.`
  return { ok: status === 'passed', status, kind: r.kind, target: r.target, project: r.project, lane: r.lane, suiteRunId: r.suiteRunId, passed, failed, total: r.runs.length, runs: r.runs, jobs: r.jobs, durationMs: Date.now() - r.started, ...(error ? { error } : {}) }
}

/**
 * Run a suite or a list of test cases and (by default) wait for the verdict.
 * @param {Client} client
 * @param {RunTestsOptions} opts
 * @returns {Promise<RunTestsResult>}
 */
export async function runTests(client, opts) {
  const tests = opts.tests?.filter(Boolean) ?? []
  if (Boolean(opts.suite) === Boolean(tests.length)) throw usage('Pass either a suite or one or more tests.')
  const started = Date.now()
  const deadline = started + (opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
  const lane = laneOf(client)
  /** @type {'suite' | 'tests'} */
  const kind = opts.suite ? 'suite' : 'tests'
  /** @type {Record<string, unknown>} */
  const override = {}
  if (opts.browser) override.browser = opts.browser
  if (opts.viewport) override.viewport = opts.viewport
  const base = { kind, project: opts.project, lane, started }
  const followOpts = { deadline, onProgress: opts.onProgress, signal: opts.signal }

  if (lane === 'ci') {
    const res = await routes.ci.run(client, opts.project, { ...(opts.suite ? { suite: opts.suite } : { flows: tests }), ...override, async: true }, { timeoutMs: Math.max(60_000, deadline - Date.now()), signal: opts.signal })
    if (!res?.async) {
      // An API without async CI runs answered with the finished result (the pre-0.1 blocking contract).
      const runs = (res?.runs ?? []).map(fromRun)
      return finish({ ...base, target: res?.suite ?? opts.suite ?? tests.join(', '), jobs: [], runs, suiteRunId: res?.id, error: res?.ok === false && !runs.length ? res?.error : undefined })
    }
    /** @type {string[]} */
    const jobs = res.jobs.map((/** @type {any} */ j) => j.id)
    const target = opts.suite ? res.jobs[0]?.target ?? opts.suite : res.jobs.map((/** @type {any} */ j) => j.key).join(', ')
    if (opts.wait === false) return queued({ ...base, target, jobs })
    return gather(client, opts.project, jobs, (id) => routes.ci.job(client, opts.project, id), { ...base, target }, followOpts)
  }

  if (opts.suite) {
    const suite = await findSuite(client, opts.project, opts.suite)
    const before = new Set((await routes.suiteRuns(client, opts.project)).map((/** @type {any} */ s) => s.id))
    const res = await routes.startSuite(client, opts.project, suite.id, override)
    const target = suite.name
    if (res?.jobId) {
      if (opts.wait === false) return queued({ ...base, target, jobs: [res.jobId] })
      return gather(client, opts.project, [res.jobId], (id) => routes.job(client, id), { ...base, target }, followOpts)
    }
    // An API that runs jobs inline (local dev) returns no job id: follow the suite run it starts.
    if (opts.wait === false) return queued({ ...base, target, jobs: [] })
    const sr = await followNew(() => routes.suiteRuns(client, opts.project).then((rows) => rows.find((/** @type {any} */ s) => s.suiteId === suite.id && !before.has(s.id))), followOpts)
    if (!sr) return finish({ ...base, target, jobs: [], runs: [], timedOut: true })
    const r = await routes.suiteRunResults(client, opts.project, sr.id)
    return finish({ ...base, target, jobs: [], runs: (r.runs ?? []).map(fromRun), suiteRunId: r.id })
  }

  /** @type {string[]} */
  const jobs = []
  /** @type {Array<{ key: string, flowId: string, before: Set<string> }>} */
  const inline = []
  for (const key of tests) {
    const flow = await routes.test(client, opts.project, key).catch((err) => {
      throw err instanceof KadeepError && err.code === 'not_found' ? new KadeepError(`No test "${key}" in this project.`, { code: 'not_found', exitCode: EXIT.USAGE }) : err
    })
    const before = new Set((await routes.runs(client, opts.project, { test: flow.id, limit: 10 })).map((/** @type {any} */ r) => r.id))
    const res = await routes.startTest(client, opts.project, flow.id, override)
    if (res?.jobId) jobs.push(res.jobId)
    else inline.push({ key, flowId: flow.id, before })
  }
  const target = tests.join(', ')
  if (opts.wait === false) return queued({ ...base, target, jobs })
  const done = jobs.length ? await gather(client, opts.project, jobs, (id) => routes.job(client, id), { ...base, target }, followOpts) : null
  /** @type {RunResult[]} */
  const runs = [...(done?.runs ?? [])]
  let timedOut = done?.status === 'timeout'
  for (const t of inline) {
    const run = await followNew(() => routes.runs(client, opts.project, { test: t.flowId, limit: 10 }).then((rows) => rows.find((/** @type {any} */ r) => !t.before.has(r.id))), followOpts, RUN_DONE)
    if (run) runs.push(fromRun(run))
    else timedOut = true
  }
  return finish({ ...base, target, jobs, runs, timedOut, error: done?.status === 'error' ? done.error : undefined })
}

/** @param {{ kind: 'suite' | 'tests', target: string, project: string, lane: 'session' | 'ci', started: number, jobs: string[] }} r @returns {RunTestsResult} */
function queued(r) {
  return { ok: true, status: 'queued', kind: r.kind, target: r.target, project: r.project, lane: r.lane, passed: 0, failed: 0, total: 0, runs: [], jobs: r.jobs, durationMs: Date.now() - r.started }
}

/**
 * Follow each job to the end and merge their runs.
 * @param {Client} client
 * @param {string} project
 * @param {string[]} jobs
 * @param {(id: string) => Promise<any>} fetchJob
 * @param {{ kind: 'suite' | 'tests', target: string, project: string, lane: 'session' | 'ci', started: number }} base
 * @param {{ deadline: number, onProgress?: (p: Progress) => void, signal?: AbortSignal }} followOpts
 */
async function gather(client, project, jobs, fetchJob, base, followOpts) {
  /** @type {RunResult[]} */
  const runs = []
  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const targets = []
  let suiteRunId
  let timedOut = false
  // The login lane can read each finished run as the job's checkpoint names it; the CI lane only learns them at the end.
  const resolveRun = laneOf(client) === 'session' ? (/** @type {string} */ id) => routes.run(client, id) : undefined
  for (const id of jobs) {
    const job = await follow(() => fetchJob(id), { ...followOpts, resolveRun })
    if (job.timedOut) {
      timedOut = true
      continue
    }
    const got = await collect(client, project, job)
    followOpts.onProgress?.(progressOf(job, progressText(job), got.runs))
    runs.push(...got.runs)
    suiteRunId ??= got.suiteRunId
    if (got.target) targets.push(got.target)
    if (got.error) errors.push(got.error)
  }
  // A job that ended without runs (crashed, cancelled) is an error even when other jobs passed: never a silent pass.
  return finish({ ...base, target: base.target || targets.join(', '), jobs, runs, suiteRunId, timedOut, error: errors.length ? errors.join('; ') : undefined })
}

/**
 * Inline servers: wait for a new row (suite run or run) to appear and reach a terminal status.
 * @param {() => Promise<any>} find
 * @param {{ deadline: number, signal?: AbortSignal }} opts
 * @param {Set<string>} [terminal]
 */
async function followNew(find, { deadline, signal }, terminal = RUN_DONE) {
  for (;;) {
    const row = await find().catch(() => null)
    if (row && (terminal.has(row.status) || row.finishedAt)) return row
    if (Date.now() > deadline) return null
    await sleep(pollMs(), signal)
  }
}

/**
 * One job's state; with `wait`, follow it and return the verdict like runTests does.
 * @param {Client} client
 * @param {{ project?: string, jobId: string, wait?: boolean, timeoutMs?: number, onProgress?: (p: Progress) => void, signal?: AbortSignal }} opts
 */
export async function jobStatus(client, opts) {
  const lane = laneOf(client)
  if (lane === 'ci' && !opts.project) throw usage('Pass --project <id> (a CI token reads jobs through its project).')
  const fetchJob = () => (lane === 'ci' ? routes.ci.job(client, /** @type {string} */ (opts.project), opts.jobId) : routes.job(client, opts.jobId))
  const snapshot = await fetchJob()
  const project = opts.project ?? snapshot.projectId
  /** @type {'suite' | 'tests'} */
  const kind = snapshot.kind === 'suite' ? 'suite' : 'tests'
  if (!opts.wait) {
    const done = Boolean(snapshot.done) || JOB_DONE.has(snapshot.status)
    return { id: snapshot.id, kind: snapshot.kind, status: snapshot.status, done, progress: snapshot.progress ?? null, error: snapshot.error, note: snapshot.note, result: snapshot.result ?? null, project }
  }
  const started = Date.now()
  return gather(client, project, [opts.jobId], () => fetchJob(), { kind, target: '', project, lane, started }, { deadline: started + (opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS), onProgress: opts.onProgress, signal: opts.signal })
}
