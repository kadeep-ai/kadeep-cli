// The KaDeep agent from the terminal: the SSE stream, a turn's record, answers and plans posted the way the web app
// posts them, interrupting, and `kadeep ask` as a script sees it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.mjs'
import { createChat, llmProblem } from '../src/agent/chat.mjs'
import { createSseParser } from '../src/agent/sse.mjs'
import { fakeApi, sse } from './fake-api.mjs'

const BIN = new URL('../bin/kadeep.mjs', import.meta.url).pathname
const person = (url) => createClient({ api: url, auth: { kind: 'token', token: 'access' } })
const words = (text) => text.match(/.{1,7}/gs).map((t) => ({ type: 'delta', text: t }))

const REPLY = [
  { type: 'mode', mode: 'agent' },
  { type: 'status', message: 'Reading the run' },
  { type: 'tool', id: 't1', name: 'navigate', args: { url: 'https://example.test/' } },
  { type: 'tool', id: 't1', name: 'navigate', result: 'Opened https://example.test/ (HTTP 200)', ok: true },
  ...words('The **checkout** test failed:\nthe heading moved.\n'),
  { type: 'run', run: { id: 'r9', flowName: 'Checkout', status: 'running' } },
  { type: 'run', run: { id: 'r9', flowName: 'Checkout', status: 'failed', verdict: 'DEFECT' } },
  { type: 'issue', issue: { id: 'i1', title: 'Heading moved', severity: 'major' } },
  { type: 'context', meter: { used: 10, capacity: 1000 } },
  { type: 'done' }
]

test('SSE: events split anywhere across chunks; pings and junk are skipped', () => {
  const got = []
  const p = createSseParser((e) => got.push(e))
  const wire = ': ping\n\ndata: {"type":"delta","text":"he"}\n\ndata: {"type":"de' + 'lta","text":"llo"}\r\n\r\ndata: not json\n\ndata: {"type":"done"}\n\n'
  for (let i = 0; i < wire.length; i += 5) p.push(wire.slice(i, i + 5))
  assert.deepEqual(got, [{ type: 'delta', text: 'he' }, { type: 'delta', text: 'llo' }, { type: 'done' }])
})

test('a turn: the chat is created once, the stream is folded into text, tools, runs and issues; history goes with the next turn', async () => {
  const bodies = []
  const api = await fakeApi({
    'POST /api/chats': ({ body }) => (bodies.push(['chat', body]), [200, { id: 'c1' }]),
    'POST /api/agent/chat': ({ body, headers }) => {
      bodies.push(['turn', body])
      assert.equal(headers.authorization, 'Bearer access')
      return sse(REPLY)
    }
  })
  const chat = createChat(person(api.url), { project: 'p1', clientId: 'cli-test' })
  const seen = []
  const t = await chat.send('why did checkout fail?', { onEvent: (e) => seen.push(e.type) })
  assert.equal(t.text, 'The **checkout** test failed:\nthe heading moved.\n')
  assert.deepEqual(t.tools, [{ id: 't1', name: 'navigate', args: { url: 'https://example.test/' }, result: 'Opened https://example.test/ (HTTP 200)', ok: true }])
  assert.deepEqual(t.runs.map((r) => [r.id, r.status]), [['r9', 'failed']], 'a run seen twice is one run, in its last state')
  assert.equal(t.issues[0].id, 'i1')
  assert.equal(t.meter.used, 10)
  assert.equal(seen.at(-1), 'done')
  await chat.send('and now?')
  await api.close()
  assert.deepEqual(bodies[0], ['chat', { projectId: 'p1', mode: 'agent' }])
  assert.equal(bodies.filter(([k]) => k === 'chat').length, 1, 'one chat for the conversation')
  const [, second] = bodies.at(-1)
  assert.equal(second.chatId, 'c1')
  assert.equal(second.clientId, 'cli-test')
  assert.deepEqual(second.history, [{ role: 'user', text: 'why did checkout fail?' }, { role: 'agent', text: t.text }])
})

test('answers and plans are posted like the web app; approving switches to agent mode and sends the plan back', async () => {
  const posts = []
  const api = await fakeApi({
    'POST /api/chats': () => [200, { id: 'c1' }],
    'POST /api/agent/hitl': ({ body }) => (posts.push(['hitl', body]), [200, { ok: true }]),
    'POST /api/agent/plan/pl1': ({ body }) => (posts.push(['plan', body]), [200, { ok: true, plan: { id: 'pl1', title: 'Cover it', status: 'approved' } }]),
    'POST /api/agent/chat': ({ body }) => (posts.push(['turn', { mode: body.mode, approvedPlan: body.approvedPlan?.id, message: body.message }]), sse([{ type: 'plan', plan: { id: 'pl1', title: 'Cover it', status: 'proposed', markdown: '1. a' } }, { type: 'done' }]))
  })
  const chat = createChat(person(api.url), { project: 'p1', clientId: 'cli-test', mode: 'plan' })
  const t = await chat.send('cover the picker')
  assert.equal(t.plan.status, 'proposed')
  await chat.answer('h1', { text: 'Which browser?\n→ Chromium' })
  const approved = await chat.decide(t.plan, 'approve')
  assert.equal(chat.mode, 'agent')
  await chat.send('', { approvedPlan: approved })
  await api.close()
  assert.deepEqual(posts, [
    ['turn', { mode: 'plan', approvedPlan: undefined, message: 'cover the picker' }],
    ['hitl', { clientId: 'cli-test', requestId: 'h1', text: 'Which browser?\n→ Chromium' }],
    ['plan', { clientId: 'cli-test', decision: 'approve' }],
    ['turn', { mode: 'agent', approvedPlan: 'pl1', message: '' }]
  ])
})

test('interrupting a turn stops it on KaDeep and ends it as stopped', async () => {
  let stopped = null
  const api = await fakeApi({
    'POST /api/chats': () => [200, { id: 'c1' }],
    'POST /api/agent/stop': ({ body }) => ((stopped = body), [200, { ok: true }]),
    'POST /api/agent/chat': () => sse([...words('This takes a while. '.repeat(20))], { gapMs: 50 })
  })
  const chat = createChat(person(api.url), { project: 'p1', clientId: 'cli-test' })
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 150)
  const t = await chat.send('slow', { signal: ac.signal })
  await api.close()
  assert.equal(t.stopped, true)
  assert.ok(t.text.length > 0 && t.text.length < 400, 'kept what arrived before the stop')
  assert.deepEqual(stopped, { clientId: 'cli-test' })
})

test('the model key check: missing, invalid and out-of-credit keys block with the fix; a working key passes', () => {
  assert.match(llmProblem({ llm: { configured: false } }), /Add your OpenRouter API key/)
  assert.match(llmProblem({ llm: { configured: true, lastIssue: { code: 'invalid' } } }), /rejected/)
  assert.match(llmProblem({ llm: { configured: true, source: 'user', lastIssue: { code: 'credits' } } }), /out of credits/)
  assert.equal(llmProblem({ llm: { configured: true, lastIssue: { code: 'rate' } } }), undefined)
  assert.equal(llmProblem(null), undefined, 'unknown: let the server decide')
})

/** `kadeep ask` against a fake API, as a script runs it (no terminal). */
function ask(args, url, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-ask-'))
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ defaults: { [url]: { project: 'p1' } } }))
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, 'ask', ...args], { env: { PATH: process.env.PATH, HOME: dir, KADEEP_CONFIG_DIR: dir, KADEEP_API: url, KADEEP_TOKEN: 'access', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (status) => done({ status, stdout, stderr }))
  })
}

test('kadeep ask: the reply on stdout as it streams, what the agent did on stderr, --json as one document', async () => {
  let llm = { llm: { configured: true } }
  const api = await fakeApi({
    'GET /api/projects': () => [200, [{ id: 'p1', name: 'Demo' }]],
    'GET /api/settings/llm': () => [200, llm],
    'POST /api/chats': () => [200, { id: 'c1' }],
    'POST /api/agent/chat': () => sse(REPLY),
    'POST /api/agent/hitl': () => [200, { ok: true }]
  })
  const plain = await ask(['why did checkout fail?'], api.url)
  assert.equal(plain.status, 0)
  assert.equal(plain.stdout, 'The **checkout** test failed:\nthe heading moved.\n', 'the markdown exactly as written')
  assert.doesNotMatch(plain.stdout + plain.stderr, /\u001b/)
  assert.match(plain.stderr, /- Opened https:\/\/example.test\/ \(HTTP 200\)/)
  assert.match(plain.stderr, /run failed: Checkout \(r9\)/)
  assert.match(plain.stderr, /issue: Heading moved/)

  const json = await ask(['why?', '--json'], api.url, { KADEEP_UI: 'rich' })
  const doc = JSON.parse(json.stdout)
  assert.equal(doc.chatId, 'c1')
  assert.deepEqual(doc.runs, [{ id: 'r9', test: 'Checkout', status: 'failed', verdict: 'DEFECT' }])
  assert.deepEqual(doc.issues, [{ id: 'i1', title: 'Heading moved', severity: 'major' }])

  llm = { llm: { configured: false } }
  const blocked = await ask(['hello'], api.url)
  await api.close()
  assert.equal(blocked.status, 2)
  assert.match(blocked.stderr, /Add your OpenRouter API key/)
})
