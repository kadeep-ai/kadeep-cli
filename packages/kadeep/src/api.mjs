// @ts-check
import { EXIT, KadeepError, usage } from './errors.mjs'

/** @typedef {import('./client.mjs').Client} Client */

const e = encodeURIComponent
/** @param {string} p */
const P = (p) => `/api/projects/${e(p)}`

/**
 * The KaDeep API routes the CLI uses, one line each. Everything is plain HTTP: `/api/*` with a login, `/api/ci/*` with
 * a project's CI token.
 */
export const routes = {
  /** @param {Client} c */
  me: (c) => c.get('/api/auth/me'),
  /** @param {Client} c */
  projects: (c) => c.get('/api/projects'),
  /** @param {Client} c @param {string} p */
  suites: (c, p) => c.get(`${P(p)}/suites`),
  /** @param {Client} c @param {string} p @param {{ label?: string, search?: string }} [q] */
  tests: (c, p, q = {}) => c.get(`${P(p)}/flows`, { query: { label: q.label, q: q.search } }),
  /** @param {Client} c @param {string} p @param {string} key */
  test: (c, p, key) => c.get(`${P(p)}/flows/${e(key)}`),
  /** @param {Client} c @param {string} p @param {{ test?: string, limit?: number, suiteRunId?: string }} [q] */
  runs: (c, p, q = {}) => c.get(`${P(p)}/runs`, { query: { flow: q.test, limit: q.limit, suiteRunId: q.suiteRunId } }),
  /** @param {Client} c @param {string} id */
  run: (c, id) => c.get(`/api/runs/${e(id)}`),
  /** @param {Client} c @param {string} p */
  suiteRuns: (c, p) => c.get(`${P(p)}/suite-runs`),
  /** @param {Client} c @param {string} p @param {string} id */
  suiteRunResults: (c, p, id) => c.get(`${P(p)}/suite-runs/${e(id)}/results`),
  /** @param {Client} c @param {string} p @param {{ status?: string }} [q] */
  issues: (c, p, q = {}) => c.get(`${P(p)}/issues`, { query: { status: q.status } }),
  /** @param {Client} c @param {string} id */
  job: (c, id) => c.get(`/api/jobs/${e(id)}`),
  /** @param {Client} c @param {string} p @param {string} key @param {Record<string, unknown>} body */
  startSuite: (c, p, key, body) => c.post(`${P(p)}/suites/${e(key)}/run`, body),
  /** @param {Client} c @param {string} p @param {string} key @param {Record<string, unknown>} body */
  startTest: (c, p, key, body) => c.post(`${P(p)}/flows/${e(key)}/run`, body),
  /** @param {Client} c @param {string} p */
  createCiToken: (c, p) => c.post(`${P(p)}/ci-token`),
  /** Whether the user's model key works (the agent answers only when it does). @param {Client} c */
  llm: (c) => c.get('/api/settings/llm'),
  chats: {
    /** @param {Client} c @param {string} p */
    list: (c, p) => c.get('/api/chats', { query: { projectId: p } }),
    /** @param {Client} c @param {string} id */
    get: (c, id) => c.get(`/api/chats/${e(id)}`),
    /** @param {Client} c @param {{ projectId: string, mode?: string, title?: string }} body */
    create: (c, body) => c.post('/api/chats', body)
  },
  agent: {
    /** One turn, streamed back as Server-Sent Events. @param {Client} c @param {Record<string, unknown>} body @param {(text: string) => void} onData @param {{ signal?: AbortSignal }} [opts] */
    chat: (c, body, onData, opts) => c.stream('/api/agent/chat', body, onData, opts),
    /** @param {Client} c @param {Record<string, unknown>} body */
    hitl: (c, body) => c.post('/api/agent/hitl', body),
    /** @param {Client} c @param {string} id @param {Record<string, unknown>} body */
    plan: (c, id, body) => c.post(`/api/agent/plan/${e(id)}`, body),
    /** @param {Client} c @param {string} clientId */
    stop: (c, clientId) => c.post('/api/agent/stop', { clientId })
  },
  ci: {
    /** @param {Client} c @param {string} p @param {Record<string, unknown>} body @param {import('./client.mjs').CallOptions} [opts] */
    run: (c, p, body, opts) => c.post(`/api/ci/${e(p)}/run`, body, { accept: [422], ...opts }),
    /** @param {Client} c @param {string} p @param {string} id */
    job: (c, p, id) => c.get(`/api/ci/${e(p)}/jobs/${e(id)}`),
    /** @param {Client} c @param {string} p */
    locStatus: (c, p) => c.get(`/api/ci/${e(p)}/loc/status`),
    /** @param {Client} c @param {string} p @param {Record<string, unknown>} query */
    locValidate: (c, p, query) => c.get(`/api/ci/${e(p)}/loc/validate`, { query, accept: [422] }),
    /** @param {Client} c @param {string} p @param {Record<string, unknown>} query */
    locPull: (c, p, query) => c.get(`/api/ci/${e(p)}/loc/pull`, { query, raw: true, headers: { accept: '*/*' } }),
    /** @param {Client} c @param {string} p @param {Buffer} bytes @param {string} fileName @param {Record<string, unknown>} query */
    locPush: (c, p, bytes, fileName, query) => c.call('POST', `/api/ci/${e(p)}/loc/push`, { query, body: bytes, headers: { 'content-type': 'application/octet-stream', 'x-file-name': e(fileName) }, accept: [409], timeoutMs: 300_000 })
  }
}

/**
 * The project a command acts on: --project, KADEEP_PROJECT, the `kadeep use` default, or your only project. A login
 * accepts an id or a name; a CI token cannot list projects, so it needs the id.
 * @param {Client} client
 * @param {{ ref?: string, env?: NodeJS.ProcessEnv, config?: import('./config.mjs').Config }} [opts]
 * @returns {Promise<{ id: string, name?: string, [k: string]: unknown }>}
 */
export async function resolveProject(client, { ref, env = process.env, config = {} } = {}) {
  const want = ref || env.KADEEP_PROJECT || config.defaults?.[client.api]?.project
  if (client.auth.kind === 'ci') {
    if (!want) throw usage('Pass --project <id> or set KADEEP_PROJECT (a CI token cannot list projects).')
    return { id: want }
  }
  /** @type {Array<{ id: string, name: string }>} */
  const all = await routes.projects(client)
  const names = () => all.map((p) => `${p.name} (${p.id})`).join(', ')
  if (want) {
    const hit = all.find((p) => p.id === want) ?? all.find((p) => p.name.toLowerCase() === want.toLowerCase())
    if (!hit) throw new KadeepError(`No project "${want}" on ${client.api}.${all.length ? ` Yours: ${names()}` : ''}`, { code: 'not_found', exitCode: EXIT.USAGE })
    return hit
  }
  if (all.length === 1) return all[0]
  if (!all.length) throw new KadeepError('You have no projects yet. Create one in the KaDeep app first.', { code: 'not_found', exitCode: EXIT.USAGE })
  throw usage(`Which project? Pass --project, set KADEEP_PROJECT, or run \`kadeep use <project>\`. Yours: ${names()}`)
}
