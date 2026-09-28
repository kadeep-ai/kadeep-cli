// @ts-check
import { routes } from '../api.mjs'
import { EXIT, KadeepError } from '../errors.mjs'

/**
 * Read-only views over projects, suites, test cases (flows in the API), runs and issues, shaped the same for
 * `--json` and the MCP tools. Times are ISO strings.
 * @typedef {import('../client.mjs').Client} Client
 */

/** @param {unknown} ms */
const iso = (ms) => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : undefined)

/** @param {any} p @param {string | undefined} defaultId */
export const projectRow = (p, defaultId) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, kind: p.kind ?? 'qa', description: p.description, hasCiToken: Boolean(p.ciToken), default: p.id === defaultId })
/** @param {any} s */
export const suiteRow = (s) => ({ id: s.id, key: s.key, name: s.name, description: s.description, tests: s.flowIds?.length ?? 0, labels: s.labels ?? [], lastRunStatus: s.lastRunStatus })
/** @param {any} f */
export const testRow = (f) => ({ id: f.id, key: f.key, name: f.name, labels: f.labels ?? [], priority: f.priority, platform: f.platform, lastRunStatus: f.lastRunStatus })
/** @param {any} r */
export const runRow = (r) => ({ id: r.id, test: r.flowName, testId: r.flowId, status: r.status, verdict: r.verdict, trigger: r.trigger, suiteRunId: r.suiteRunId, startedAt: iso(r.startedAt), durationMs: r.durationMs })

/** @param {Client} client @param {string | undefined} defaultId @returns {Promise<Array<ReturnType<typeof projectRow>>>} */
export async function listProjects(client, defaultId) {
  return (await routes.projects(client)).map((/** @type {any} */ p) => projectRow(p, defaultId))
}

/** @param {Client} client @param {string} project @returns {Promise<Array<ReturnType<typeof suiteRow>>>} */
export async function listSuites(client, project) {
  return (await routes.suites(client, project)).map(suiteRow)
}

/**
 * @param {Client} client
 * @param {string} project
 * @param {string} ref id, key or name
 */
export async function findSuite(client, project, ref) {
  const all = await routes.suites(client, project)
  const hit = all.find((/** @type {any} */ s) => s.id === ref || s.key === ref) ?? all.find((/** @type {any} */ s) => s.name.toLowerCase() === ref.toLowerCase())
  if (!hit) throw new KadeepError(`No suite "${ref}" in this project. Suites: ${all.map((/** @type {any} */ s) => s.key).join(', ') || 'none'}`, { code: 'not_found', exitCode: EXIT.USAGE })
  return hit
}

/** @param {Client} client @param {string} project @param {{ suite?: string, label?: string, search?: string }} [q] @returns {Promise<Array<ReturnType<typeof testRow>>>} */
export async function listTests(client, project, q = {}) {
  let rows = await routes.tests(client, project, { label: q.label, search: q.search })
  if (q.suite) {
    const suite = await findSuite(client, project, q.suite)
    const ids = new Set(suite.flowIds ?? [])
    rows = rows.filter((/** @type {any} */ f) => ids.has(f.id))
  }
  return rows.map(testRow)
}

/** @param {Client} client @param {string} project @param {string} key */
export async function getTest(client, project, key) {
  const f = await routes.test(client, project, key)
  return { ...testRow(f), description: f.description, instructions: f.instructions, preconditions: f.preconditions, testData: f.testData, steps: f.steps, expected: f.expected, suiteIds: f.suiteIds ?? [], lastRunId: f.lastRunId, version: f.versions?.length, updatedAt: iso(f.updatedAt) }
}

/** @param {Client} client @param {string} project @param {{ test?: string, limit?: number }} [q] @returns {Promise<Array<ReturnType<typeof runRow>>>} */
export async function listRuns(client, project, q = {}) {
  return (await routes.runs(client, project, { test: q.test, limit: q.limit ?? 20 })).map(runRow)
}

/** @param {any} r */
export const runDetail = (r) => ({
  ...runRow(r),
  verdictReason: r.verdictReason,
  summary: r.summary,
  error: r.error,
  browser: r.browser,
  viewport: r.viewport,
  finalUrl: r.finalUrl,
  report: r.reportPath,
  finishedAt: iso(r.finishedAt),
  issues: r.issueIds?.length ?? 0,
  steps: (r.actions ?? []).map((/** @type {any} */ a) => ({ n: a.index + 1, ok: a.ok, tool: a.tool, target: a.target?.name ?? a.target?.label, result: a.result }))
})

/** @param {Client} client @param {string} id */
export async function getRun(client, id) {
  return runDetail(await routes.run(client, id))
}

/** @param {any} sr */
const suiteRunRow = (sr) => ({ id: sr.id, suite: sr.suiteName, suiteId: sr.suiteId, status: sr.status, passed: sr.passed, failed: sr.failed, trigger: sr.trigger, startedAt: iso(sr.startedAt), finishedAt: iso(sr.finishedAt) })

/** @param {Client} client @param {string} project @param {{ suite?: string, limit?: number }} [q] @returns {Promise<Array<ReturnType<typeof suiteRunRow>>>} */
export async function listSuiteRuns(client, project, q = {}) {
  let rows = await routes.suiteRuns(client, project)
  if (q.suite) {
    const suite = await findSuite(client, project, q.suite)
    rows = rows.filter((/** @type {any} */ sr) => sr.suiteId === suite.id)
  }
  return rows.slice(0, q.limit ?? 20).map(suiteRunRow)
}

/** @param {Client} client @param {string} project @param {string} id */
export async function getSuiteRun(client, project, id) {
  const r = await routes.suiteRunResults(client, project, id)
  return { id: r.id, suite: r.suite, status: r.status, passed: r.passed, failed: r.failed, startedAt: iso(r.startedAt), finishedAt: iso(r.finishedAt), runs: r.runs }
}

/** @param {any} i */
const issueRow = (i) => ({ id: String(i.id), title: String(i.title), severity: String(i.severity), type: i.type, status: String(i.status), testId: i.flowId, runId: i.runId, ticket: i.externalTicket?.url ?? i.externalTicket?.key, createdAt: iso(i.createdAt) })

/** @param {Client} client @param {string} project @param {{ status?: string }} [q] @returns {Promise<Array<ReturnType<typeof issueRow>>>} */
export async function listIssues(client, project, q = {}) {
  const { issues } = await routes.issues(client, project, { status: q.status })
  return (issues ?? []).map(issueRow)
}
