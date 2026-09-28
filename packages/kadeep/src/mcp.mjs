// @ts-check
import { createInterface } from 'node:readline'
import { resolveProject, routes } from './api.mjs'
import { createClient, resolveAuth } from './client.mjs'
import { loadConfig, resolveApi } from './config.mjs'
import { KadeepError, VERSION } from './errors.mjs'
import { getRun, getSuiteRun, getTest, listIssues, listProjects, listRuns, listSuiteRuns, listSuites, listTests } from './ops/browse.mjs'
import { locStatus, locValidate } from './ops/loc.mjs'
import { BROWSERS, jobStatus, runTests, VIEWPORTS } from './ops/run.mjs'

/**
 * `kadeep mcp`: a Model Context Protocol server on stdio (newline-delimited JSON-RPC) for Cursor, Claude Code and any
 * other MCP client. Tools call the same functions as the CLI and return the same JSON as `--json`. Runs are queued
 * jobs that are polled, so a tool call never holds a request open against KaDeep. Only protocol messages go to stdout;
 * logs go to stderr.
 *
 * @typedef {{ name: string, title: string, description: string, inputSchema: object, readOnly?: boolean, run: (args: any, x: ToolContext) => Promise<unknown> }} Tool
 * @typedef {{ client: (need: 'user' | 'run' | 'ci' | 'any') => import('./client.mjs').Client, project: (client: import('./client.mjs').Client, ref?: string) => Promise<string>, api: string, defaultProject?: string, signal: AbortSignal, progress: (message: string) => void }} ToolContext
 */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

const INSTRUCTIONS = [
  'KaDeep is a QA platform: projects hold test cases (called tests; "flows" in the API) grouped into suites; runs record each execution.',
  'Pass `project` (id or name) unless a default is configured; projects_list shows what exists.',
  '`run` queues a suite or tests and waits for the verdict (up to max_wait_seconds); if it is still running, call job_status with wait: true.',
  'Localization tools need the project CI token (KADEEP_CI_TOKEN) in the server environment.'
].join(' ')

/** @param {Record<string, object>} properties @param {string[]} [required] */
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const projectProp = { project: { type: 'string', description: 'Project id or name. Defaults to KADEEP_PROJECT, then `kadeep use`, then your only project.' } }
const limitProp = { limit: { type: 'integer', minimum: 1, maximum: 200, description: 'How many rows (default 20)' } }

/** @type {Tool[]} */
export const TOOLS = [
  {
    name: 'whoami',
    title: 'Who am I',
    description: 'The KaDeep account and API this server uses.',
    inputSchema: schema({}),
    readOnly: true,
    run: async (_a, x) => {
      const me = await routes.me(x.client('user'))
      return { api: x.api, user: { id: me.id, email: me.email, name: me.name, role: me.role } }
    }
  },
  {
    name: 'projects_list',
    title: 'List projects',
    description: 'Projects you can see, with id, name, base URL and kind (qa or localization).',
    inputSchema: schema({}),
    readOnly: true,
    run: async (_a, x) => listProjects(x.client('user'), x.defaultProject)
  },
  {
    name: 'suites_list',
    title: 'List suites',
    description: 'Suites in a project: key, name, number of tests, last run status.',
    inputSchema: schema(projectProp),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return listSuites(c, await x.project(c, a.project))
    }
  },
  {
    name: 'tests_list',
    title: 'List test cases',
    description: 'Test cases in a project, optionally only those in a suite, with a label, or matching text.',
    inputSchema: schema({ ...projectProp, suite: { type: 'string', description: 'Suite key, id or name' }, label: { type: 'string' }, search: { type: 'string', description: 'Text to match in name, key or instructions' } }),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return listTests(c, await x.project(c, a.project), { suite: a.suite, label: a.label, search: a.search })
    }
  },
  {
    name: 'tests_get',
    title: 'Read a test case',
    description: 'One test case in full: instructions, steps, expected result, labels, last run.',
    inputSchema: schema({ ...projectProp, test: { type: 'string', description: 'Test key, id or name' } }, ['test']),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return getTest(c, await x.project(c, a.project), a.test)
    }
  },
  {
    name: 'run',
    title: 'Run tests',
    description: 'Run a suite, or one or more test cases, and wait for the verdict. Returns pass/fail per test with errors and summaries. Uses real browser time and model credits.',
    inputSchema: schema({
      ...projectProp,
      suite: { type: 'string', description: 'Suite key, id or name (or pass tests)' },
      tests: { type: 'array', items: { type: 'string' }, description: 'Test keys, ids or names (or pass suite)' },
      browser: { type: 'string', enum: BROWSERS },
      viewport: { type: 'string', enum: VIEWPORTS },
      wait: { type: 'boolean', description: 'Wait for the verdict (default true). false returns the job id at once.' },
      max_wait_seconds: { type: 'integer', minimum: 10, maximum: 3600, description: 'Stop waiting after this long (default 600); the run continues and job_status follows it.' }
    }),
    run: async (a, x) => {
      const c = x.client('run')
      const r = await runTests(c, { project: await x.project(c, a.project), suite: a.suite, tests: a.tests, browser: a.browser, viewport: a.viewport, wait: a.wait !== false, timeoutMs: (a.max_wait_seconds ?? 600) * 1000, onProgress: (p) => x.progress(p.message), signal: x.signal })
      if (r.status !== 'timeout') return r
      const { error, ...rest } = r
      return { ...rest, status: 'running', hint: `Still running. Call job_status with job_id "${r.jobs[0]}" and wait: true.` }
    }
  },
  {
    name: 'job_status',
    title: 'Job status',
    description: 'State of a queued or running job from `run`; with wait: true, follow it to the verdict.',
    inputSchema: schema({ job_id: { type: 'string' }, ...projectProp, wait: { type: 'boolean' }, max_wait_seconds: { type: 'integer', minimum: 10, maximum: 3600 } }, ['job_id']),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('run')
      const project = c.auth.kind === 'ci' ? await x.project(c, a.project) : a.project
      return jobStatus(c, { project, jobId: a.job_id, wait: Boolean(a.wait), timeoutMs: (a.max_wait_seconds ?? 600) * 1000, onProgress: (p) => x.progress(p.message), signal: x.signal })
    }
  },
  {
    name: 'runs_list',
    title: 'Recent runs',
    description: 'Recent test runs in a project, optionally for one test: status, verdict, when, how long.',
    inputSchema: schema({ ...projectProp, test: { type: 'string', description: 'Test key, id or name' }, ...limitProp }),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return listRuns(c, await x.project(c, a.project), { test: a.test, limit: a.limit })
    }
  },
  {
    name: 'run_get',
    title: 'Read a run',
    description: 'One run step by step: each action, what failed, the verdict and its reason, the report link.',
    inputSchema: schema({ run_id: { type: 'string' } }, ['run_id']),
    readOnly: true,
    run: async (a, x) => getRun(x.client('user'), a.run_id)
  },
  {
    name: 'suite_runs_list',
    title: 'Recent suite runs',
    description: 'Recent suite runs in a project with pass / fail counts.',
    inputSchema: schema({ ...projectProp, suite: { type: 'string' }, ...limitProp }),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return listSuiteRuns(c, await x.project(c, a.project), { suite: a.suite, limit: a.limit })
    }
  },
  {
    name: 'suite_run_get',
    title: 'Read a suite run',
    description: 'A suite run\'s results: every test with status, verdict, error and summary.',
    inputSchema: schema({ ...projectProp, suite_run_id: { type: 'string' } }, ['suite_run_id']),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return getSuiteRun(c, await x.project(c, a.project), a.suite_run_id)
    }
  },
  {
    name: 'issues_list',
    title: 'List defects',
    description: 'Defects KaDeep filed in a project, with severity and status.',
    inputSchema: schema({ ...projectProp, status: { type: 'string', enum: ['new', 'dismissed', 'closed'] } }),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('user')
      return listIssues(c, await x.project(c, a.project), { status: a.status })
    }
  },
  {
    name: 'loc_status',
    title: 'Localization status',
    description: 'Coverage, readiness and critical flags per locale, and delivery states (needs KADEEP_CI_TOKEN).',
    inputSchema: schema(projectProp),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('ci')
      return locStatus(c, { project: await x.project(c, a.project) })
    }
  },
  {
    name: 'loc_validate',
    title: 'Localization quality gate',
    description: 'Whether the requested locales are approved, covered and free of critical flags, with the reasons if not (needs KADEEP_CI_TOKEN).',
    inputSchema: schema({ ...projectProp, locales: { type: 'array', items: { type: 'string' } }, min_coverage: { type: 'number', minimum: 0, maximum: 100 }, min_mqm: { type: 'number' }, allow_unapproved: { type: 'boolean' } }),
    readOnly: true,
    run: async (a, x) => {
      const c = x.client('ci')
      return locValidate(c, { project: await x.project(c, a.project), locales: a.locales, minCoverage: a.min_coverage, minMqm: a.min_mqm, allowUnapproved: a.allow_unapproved })
    }
  }
]

/**
 * The protocol logic, transport-free: feed it parsed messages, it calls `send` with responses and notifications.
 * @param {{ env?: NodeJS.ProcessEnv, send: (msg: object) => void, log?: (line: string) => void }} opts
 */
export function createMcpServer({ env = process.env, send, log = () => undefined }) {
  let protocol = PROTOCOL_VERSIONS[0]
  /** @type {Map<string | number, AbortController>} */
  const inflight = new Map()

  /** @param {string | number | null} id @param {number} code @param {string} message */
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

  /** @param {any} msg */
  async function callTool(msg) {
    const tool = TOOLS.find((t) => t.name === msg.params?.name)
    if (!tool) return fail(msg.id, -32602, `Unknown tool: ${msg.params?.name}`)
    const abort = new AbortController()
    inflight.set(msg.id, abort)
    const token = msg.params?._meta?.progressToken
    let step = 0
    const config = loadConfig(env)
    const api = resolveApi({ env, config })
    /** @type {ToolContext} */
    const x = {
      api,
      defaultProject: env.KADEEP_PROJECT || config.defaults?.[api]?.project,
      client: (need) => createClient({ api, auth: resolveAuth(need, { api, env, config }), env }),
      project: async (client, ref) => (await resolveProject(client, { ref, env, config })).id,
      signal: abort.signal,
      progress: (message) => {
        if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } })
      }
    }
    try {
      const data = await tool.run(msg.params?.arguments ?? {}, x)
      if (abort.signal.aborted) return
      /** @type {Record<string, unknown>} */
      const result = { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
      if (protocol >= '2025-06-18') result.structuredContent = Array.isArray(data) ? { items: data } : data
      send({ jsonrpc: '2.0', id: msg.id, result })
    } catch (err) {
      if (abort.signal.aborted) return
      const e = /** @type {Error} */ (err)
      if (!(err instanceof KadeepError)) log(`kadeep mcp: ${tool.name} failed: ${e?.stack ?? e}`)
      send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${e?.message ?? String(err)}` }], isError: true } })
    } finally {
      inflight.delete(msg.id)
    }
  }

  /** @param {any} msg */
  async function handle(msg) {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return fail(msg?.id ?? null, -32600, 'Invalid request')
    const isRequest = msg.id !== undefined && msg.id !== null
    if (!isRequest) {
      if (msg.method === 'notifications/cancelled') inflight.get(msg.params?.requestId)?.abort()
      return
    }
    if (typeof msg.method !== 'string') return // a response to something we never send
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion
        protocol = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0]
        return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: protocol, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'kadeep', title: 'KaDeep', version: VERSION }, instructions: INSTRUCTIONS } })
      }
      case 'ping':
        return send({ jsonrpc: '2.0', id: msg.id, result: {} })
      case 'tools/list':
        return send({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, readOnlyHint: Boolean(t.readOnly), openWorldHint: true } })) } })
      case 'tools/call':
        return callTool(msg)
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`)
    }
  }

  return {
    handle,
    abortAll: () => {
      for (const a of inflight.values()) a.abort()
    },
    inflight: () => inflight.size
  }
}

/**
 * Serve MCP over stdio until the client closes stdin.
 * @param {{ env?: NodeJS.ProcessEnv, stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [opts]
 */
export function serveMcp({ env = process.env, stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  const server = createMcpServer({ env, send: (msg) => stdout.write(`${JSON.stringify(msg)}\n`), log: (line) => stderr.write(`${line}\n`) })
  const rl = createInterface({ input: stdin, crlfDelay: Infinity })
  /** @type {Set<Promise<unknown>>} */
  const pending = new Set()
  rl.on('line', (line) => {
    if (!line.trim()) return
    /** @type {any} */
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`)
      return
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const p = Promise.resolve(server.handle(m)).finally(() => pending.delete(p))
      pending.add(p)
    }
  })
  stderr.write(`kadeep MCP server ${VERSION} on stdio · API ${resolveApi({ env })}\n`)
  return new Promise((resolve) => {
    rl.on('close', () => {
      server.abortAll()
      Promise.allSettled([...pending]).then(() => resolve(undefined))
    })
  })
}
