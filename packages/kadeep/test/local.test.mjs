// The local runner and the agent-first commands, without a browser or a model: a scripted model drives a fake
// browser, the model picker gets a fake SDK class, and `kadeep try` talks to the fake API.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAgent, TOOLS } from '../src/local/runner.mjs'
import { createModel, modelError, DEFAULT_MODEL } from '../src/local/model.mjs'
import { normalizeUrl } from '../src/ops/local.mjs'
import { planAgentInit, applyWrites } from '../src/ops/init.mjs'
import { SKILL_MD, AGENTS_SECTION } from '../src/agent-skill.mjs'
import { createMcpServer } from '../src/mcp.mjs'
import { detectAgent } from '../src/commands/try.mjs'
import { fakeApi } from './fake-api.mjs'

const BIN = new URL('../bin/kadeep.mjs', import.meta.url).pathname

/** A browser that records what it was asked to do. */
function fakeBrowser({ failOn } = {}) {
  const acts = []
  let shots = 0
  let n = 0
  return {
    acts,
    page: {},
    async snapshot() {
      return { url: 'http://localhost:3000/', title: 'Shop', snapshot: `- button "Buy" [ref=e5]\n- textbox "Email" [ref=e4]\n(${n})` }
    },
    async act(name, input) {
      acts.push([name, input])
      n++
      if (name === failOn) throw new Error('Timeout 10000ms exceeded.\nCall log: …')
      return `${name} ok`
    },
    async screenshot(label) {
      shots++
      return { path: `/tmp/k/${shots}-${label}.jpg`, base64: 'AAAA' }
    },
    drain: () => (n === 2 ? { console: [{ kind: 'pageerror', text: 'TypeError: total is undefined' }], network: [{ method: 'POST', url: 'http://localhost:3000/api/cart', status: 500 }] } : { console: [], network: [] }),
    evidence: () => ({ console: [{ kind: 'pageerror', text: 'TypeError: total is undefined' }], network: [], screenshots: Array.from({ length: shots }, (_, i) => `/tmp/k/${i + 1}.jpg`) }),
    async close() {}
  }
}

/** A model that answers with the given turns in order, and keeps every request it got. */
function scriptedModel(turns) {
  const requests = []
  let i = 0
  return {
    requests,
    provider: 'anthropic',
    model: DEFAULT_MODEL,
    async create(params) {
      requests.push(structuredClone(params))
      const t = turns[Math.min(i++, turns.length - 1)]
      return { stop_reason: t.stop ?? 'tool_use', content: t.content, usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50 } }
    }
  }
}
const use = (id, name, input) => ({ type: 'tool_use', id, name, input })

test('the agent drives the browser to a verdict and keeps the conversation append-only', async () => {
  const browser = fakeBrowser()
  const model = scriptedModel([
    { content: [{ type: 'thinking', thinking: '', signature: 'sig' }, use('t1', 'fill', { ref: 'e4', text: 'test+kadeep@example.com' }), use('t2', 'click', { ref: 'e5', element: 'Buy' })] },
    { content: [use('t3', 'report_bug', { title: 'Cart total crashes', severity: 'major', actual: 'Error page', expected: 'Total shown', steps: ['Click Buy'] })] },
    { content: [use('t4', 'finish', { verdict: 'fail', summary: 'Buying crashes the cart.', checks: [{ check: 'Buy adds to cart', passed: false }] })], stop: 'tool_use' }
  ])
  const r = await runAgent({ url: 'http://localhost:3000/', goal: 'buy something', model, browser, dir: '/tmp/k' })
  assert.equal(r.verdict, 'fail')
  assert.equal(r.ok, false)
  assert.equal(r.summary, 'Buying crashes the cart.')
  assert.deepEqual(browser.acts.map((a) => a[0]), ['navigate', 'fill', 'click'])
  assert.equal(r.steps.length, 3)
  assert.equal(r.bugs.length, 1)
  assert.equal(r.bugs[0].severity, 'major')
  assert.ok(r.bugs[0].screenshot)
  assert.equal(r.model.turns, 3)
  assert.deepEqual(r.model.usage, { input: 300, output: 60, cacheRead: 150 })
  // Append-only: each request's messages start with the previous request's messages, unchanged (thinking included).
  for (let k = 1; k < model.requests.length; k++) assert.deepEqual(model.requests[k].messages.slice(0, model.requests[k - 1].messages.length), model.requests[k - 1].messages)
  assert.equal(model.requests[1].messages[1].content[0].type, 'thinking')
  // Tool results carry the new snapshot and the evidence collected since the last step.
  const results = model.requests[1].messages[2].content
  assert.equal(results.length, 2)
  const text = results.map((x) => x.content).join('\n')
  assert.match(text, /Uncaught exception: TypeError: total is undefined/)
  assert.match(text, /Failed request: POST http:\/\/localhost:3000\/api\/cart → 500/)
  assert.deepEqual(model.requests[0].cache_control, { type: 'ephemeral' })
  assert.deepEqual(model.requests[0].tool_choice, { type: 'auto' })
})

test('a failing action is reported to the model as an error, and a pass with a critical bug is a fail', async () => {
  const browser = fakeBrowser({ failOn: 'click' })
  const model = scriptedModel([
    { content: [use('t1', 'click', { ref: 'e5' })] },
    { content: [use('t2', 'report_bug', { title: 'Checkout down', severity: 'critical', actual: 'Blank' }), use('t3', 'finish', { verdict: 'pass', summary: 'ok' })] }
  ])
  const r = await runAgent({ url: 'http://localhost:3000/', goal: 'g', model, browser, dir: '/tmp/k' })
  const res = model.requests[1].messages[2].content[0]
  assert.equal(res.is_error, true)
  assert.match(res.content, /^Action failed: Timeout 10000ms exceeded\./)
  assert.equal(r.steps[1].ok, false)
  assert.equal(r.verdict, 'fail')
})

test('the action limit makes the model finish, and a refusal ends with no verdict', async () => {
  const clicks = Array.from({ length: 5 }, (_, i) => ({ content: [use(`c${i}`, 'click', { ref: 'e5' })] }))
  const model = scriptedModel([...clicks, { content: [use('f', 'finish', { verdict: 'pass', summary: 'done' })] }])
  const browser = fakeBrowser()
  const r = await runAgent({ url: 'http://localhost:3000/', goal: 'g', model, browser, dir: '/tmp/k', maxSteps: 3 })
  assert.equal(browser.acts.length, 1 + 3)
  assert.match(model.requests[4].messages.at(-1).content[0].content, /Action limit \(3\) reached/)
  assert.equal(r.verdict, 'pass')

  const refused = await runAgent({ url: 'http://localhost:3000/', goal: 'g', model: scriptedModel([{ stop: 'refusal', content: [] }]), browser: fakeBrowser(), dir: '/tmp/k' })
  assert.equal(refused.verdict, 'error')
  assert.equal(refused.ok, false)
})

test('look sends a screenshot to the model as an image', async () => {
  const model = scriptedModel([{ content: [use('l', 'look', {})] }, { content: [use('f', 'finish', { verdict: 'pass', summary: 's' })] }])
  await runAgent({ url: 'http://localhost:3000/', goal: 'g', model, browser: fakeBrowser(), dir: '/tmp/k' })
  const res = model.requests[1].messages[2].content[0]
  assert.equal(res.content[0].type, 'image')
  assert.equal(res.content[0].source.media_type, 'image/jpeg')
})

test('tool schemas are strict-shaped and finish is offered', () => {
  for (const t of TOOLS) {
    assert.equal(t.input_schema.type, 'object')
    assert.equal(t.input_schema.additionalProperties, false)
  }
  assert.ok(TOOLS.find((t) => t.name === 'finish'))
})

test('URLs: localhost gets http, bare hosts get https, other schemes are refused', () => {
  assert.equal(normalizeUrl('localhost:3000/signup'), 'http://localhost:3000/signup')
  assert.equal(normalizeUrl('127.0.0.1:5173'), 'http://127.0.0.1:5173/')
  assert.equal(normalizeUrl('example.com'), 'https://example.com/')
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http and https/)
  assert.throws(() => normalizeUrl(''), /Give a URL/)
})

class FakeAnthropic {
  static made = []
  constructor(opts) {
    if (!opts.authToken && !process.env.__FAKE_ANTHROPIC_KEY) throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.')
    this.opts = opts
    FakeAnthropic.made.push(this)
    const create = async (p) => ({ path: this.opts.baseURL ? 'messages' : 'beta.messages', p })
    this.messages = { create }
    this.beta = { messages: { create } }
  }
}

test('model choice: own Anthropic key first, then KaDeep\'s plan, else a clear way forward', async () => {
  const api = 'https://api.example'
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-model-'))
  process.env.__FAKE_ANTHROPIC_KEY = '1'
  const own = createModel({ Anthropic: FakeAnthropic, api, env: { ANTHROPIC_API_KEY: 'k', KADEEP_TOKEN: 't', KADEEP_CONFIG_DIR: dir } })
  assert.equal(own.provider, 'anthropic')
  const sent = await own.create({ max_tokens: 1 })
  assert.equal(sent.path, 'beta.messages')
  assert.deepEqual(sent.p.betas, ['server-side-fallback-2026-07-01'])
  assert.equal(sent.p.fallbacks, 'default')
  assert.equal(sent.p.model, 'claude-opus-5-5')
  assert.deepEqual(sent.p.output_config, { effort: 'medium' })
  delete process.env.__FAKE_ANTHROPIC_KEY

  const plan = createModel({ Anthropic: FakeAnthropic, api, env: { KADEEP_TOKEN: 'tok', KADEEP_CONFIG_DIR: dir } })
  assert.equal(plan.provider, 'kadeep')
  assert.equal(FakeAnthropic.made.at(-1).opts.baseURL, 'https://api.example/api/agent-model')
  assert.equal(FakeAnthropic.made.at(-1).opts.authToken, 'tok')
  assert.equal((await plan.create({ max_tokens: 1 })).path, 'messages')

  assert.throws(() => createModel({ Anthropic: FakeAnthropic, api, env: { KADEEP_CONFIG_DIR: dir } }), (err) => err.code === 'model_required' && /kadeep try/.test(err.message))
  assert.throws(() => createModel({ Anthropic: FakeAnthropic, api, env: { KADEEP_CONFIG_DIR: dir }, provider: 'kadeep' }), (err) => err.code === 'model_required')
})

test('model errors tell the agent what to do', () => {
  const credit = modelError({ status: 402, error: { type: 'error', error: { type: 'credit_exhausted', message: 'no credit' }, claimUrl: 'https://kadeep.ai/claim/abc' } }, { provider: 'kadeep' })
  assert.equal(credit.code, 'credit_exhausted')
  assert.match(credit.message, /https:\/\/kadeep\.ai\/claim\/abc/)
  assert.equal(modelError({ status: 401, error: {} }, { provider: 'anthropic' }).code, 'model_auth')
  assert.equal(modelError({ status: 404, error: {} }, { provider: 'kadeep' }).code, 'model_unavailable')
  assert.equal(modelError({ status: 403, error: { type: 'error', error: { type: 'not_on_plan', message: 'own provider' } } }, { provider: 'kadeep' }).code, 'not_on_plan')
  assert.equal(modelError({ status: 529, error: {} }, { provider: 'anthropic' }).exitCode, 3)
})

test('init --agent writes the skill, an AGENTS.md section and MCP configs, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-agent-init-'))
  const first = applyWrites(planAgentInit({ dir, api: 'https://api.kadeep.ai', force: false }))
  assert.deepEqual(first.map((f) => f.action), ['created', 'created', 'created', 'created', 'created', 'created'])
  assert.equal(readFileSync(join(dir, '.claude/skills/kadeep/SKILL.md'), 'utf8'), SKILL_MD)
  assert.equal(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), AGENTS_SECTION)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.mcp.json'), 'utf8')).mcpServers.kadeep.args.slice(-1), ['mcp'])
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /^\.kadeep\/$/m)
  const again = applyWrites(planAgentInit({ dir, api: 'https://api.kadeep.ai', force: false }))
  assert.ok(again.every((f) => f.action === 'unchanged'), JSON.stringify(again))
})

test('the repository skill is the one init --agent writes', () => {
  assert.equal(readFileSync(new URL('../../../skills/kadeep/SKILL.md', import.meta.url), 'utf8'), SKILL_MD)
  assert.match(SKILL_MD, /^---\nname: kadeep\ndescription: .{50,1024}\n---\n/)
})

test('MCP lists the local tools first and explains how to unblock', () => {
  const sent = []
  const server = createMcpServer({ env: {}, send: (m) => sent.push(m) })
  server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
  server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = sent[1].result.tools.map((t) => t.name)
  assert.deepEqual(names.slice(0, 3), ['test_url', 'a11y_audit', 'start_trial'])
  assert.match(sent[0].result.instructions, /start_trial/)
})

test('agent detection from the environment', () => {
  assert.equal(detectAgent({ CLAUDECODE: '1' }), 'claude-code')
  assert.equal(detectAgent({ CURSOR_TRACE_ID: 'x' }), 'cursor')
  assert.equal(detectAgent({}), null)
})

let api
before(async () => {
  api = await fakeApi({
    'POST /api/public/try': ({ body }) => [201, { token: 'try_tok', expiresAt: new Date(Date.now() + 3600e3).toISOString(), claimUrl: 'https://kadeep.ai/claim/c1', projectId: 'p_try', limits: { creditUsd: 1, expiresInHours: 72 }, echo: body }],
    'GET /api/projects': ({ headers }) => (headers.authorization === 'Bearer try_tok' ? [200, [{ id: 'p_try', name: 'Trial sandbox' }]] : [401, { error: 'no' }])
  })
})
after(() => api.close())

function kadeep(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, KADEEP_API: api.url, ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

test('kadeep try starts a trial that the other commands then use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-try-'))
  const env = { HOME: dir, KADEEP_CONFIG_DIR: dir, CLAUDECODE: '1' }
  const before = await kadeep(['projects', '--json'], env)
  assert.equal(before.status, 2)
  assert.match(JSON.parse(before.stdout).error, /kadeep try/)
  const t = await kadeep(['try', '--json'], env)
  assert.equal(t.status, 0, t.stderr)
  const out = JSON.parse(t.stdout)
  assert.equal(out.claimUrl, 'https://kadeep.ai/claim/c1')
  assert.equal(out.reused, false)
  const projects = await kadeep(['projects', '--json'], env)
  assert.equal(projects.status, 0, projects.stderr)
  assert.equal(JSON.parse(projects.stdout)[0].id, 'p_try')
  const again = await kadeep(['try', '--json'], env)
  assert.equal(JSON.parse(again.stdout).reused, true)
  assert.equal(api.log.filter((l) => l === 'POST /api/public/try').length, 1)
})
