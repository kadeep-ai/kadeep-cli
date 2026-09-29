// The interactive home (`kadeep` in a terminal), driven in-process with a fake keyboard and screen against a
// stand-in API: browse without copying ids, talk to the agent, interrupt, search, first sign-in, and a terminal
// left clean at the end.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSession, splitArgs } from '../src/session/index.mjs'
import { strip } from '../src/ui/index.mjs'
import { fakeApi, sse } from './fake-api.mjs'

process.env.KADEEP_POLL_MS = '10'

const RUNS = { r1: ['Login works', 'passed'], r2: ['Checkout heading', 'failed'] }
const run = (id) => ({ id, flowId: `f_${id}`, flowName: RUNS[id][0], status: RUNS[id][1], verdict: RUNS[id][1] === 'passed' ? 'PASS' : 'DEFECT', durationMs: 9000, startedAt: Date.now() - 3_600_000, error: RUNS[id][1] === 'passed' ? undefined : 'Expected the Globex heading', actions: [{ index: 0, ok: true, tool: 'navigate', result: 'Opened the app' }] })
const flows = [{ id: 'f_r1', key: 'login-works', name: 'Login works', lastRunStatus: 'passed', labels: [] }, { id: 'f_r2', key: 'checkout-heading', name: 'Checkout heading', lastRunStatus: 'failed', labels: [] }]
let api
const log = { turns: [], stops: 0 }

before(async () => {
  api = await fakeApi({
    'GET /api/projects': () => [200, [{ id: 'p1', name: 'KaDeep CLI demo' }]],
    'GET /api/projects/p1/suites': () => [200, [{ id: 's1', key: 'smoke', name: 'Smoke', flowIds: ['f_r1', 'f_r2'] }]],
    'GET /api/projects/p1/suite-runs': () => [200, []],
    'GET /api/projects/p1/flows': () => [200, flows],
    'GET /api/projects/p1/flows/checkout-heading': () => [200, { ...flows[1], instructions: 'Check the heading.', expected: 'The Globex heading shows' }],
    'GET /api/projects/p1/runs': () => [200, Object.keys(RUNS).map(run)],
    'GET /api/runs/r1': () => [200, run('r1')],
    'GET /api/runs/r2': () => [200, run('r2')],
    'POST /api/projects/p1/suites/s1/run': () => [200, { ok: true, jobId: 'j1' }],
    'GET /api/jobs/j1': () => [200, { id: 'j1', kind: 'suite', status: 'running', progress: { done: 0, total: 2, message: 'Case 1 of 2' }, checkpoint: { completedRunIds: [] } }],
    'GET /api/settings/llm': () => [200, { llm: { configured: true } }],
    'POST /api/chats': () => [200, { id: 'c1' }],
    'POST /api/agent/stop': () => (log.stops++, [200, { ok: true }]),
    'POST /api/agent/chat': ({ body }) => {
      log.turns.push(body)
      if (/slow/.test(body.message)) return sse(Array.from({ length: 60 }, () => ({ type: 'delta', text: 'still working. ' })), { gapMs: 60 })
      return sse([{ type: 'tool', id: 't', name: 'get_run', args: {} }, { type: 'tool', id: 't', name: 'get_run', result: 'Run r2 failed', ok: true }, { type: 'delta', text: 'The heading **moved** to the tenant picker.\n' }, { type: 'done' }])
    }
  })
})
after(() => api.close())

/** A terminal stream that records what is drawn. */
function screen(columns = 100) {
  const s = Object.assign(new EventEmitter(), { isTTY: true, columns, out: '', getColorDepth: () => 24 })
  s.write = (c) => ((s.out += c), true)
  return s
}

/**
 * Start a session and hand back a driver: type keys, wait for text to appear (after what is already on screen).
 * @param {{ signedIn?: boolean }} [o]
 */
function session(o = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-session-'))
  const cfg = { ui: { welcomeSeen: true }, ...(o.signedIn === false ? {} : { sessions: { [api.url]: { accessToken: 'tok', refreshToken: 'ref', user: { id: 'u1', email: 'you@kadeep.ai' } } }, defaults: { [api.url]: { project: 'p1' } } }) }
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(v) { this.raw = v }, setEncoding() {}, resume() {}, pause() {} })
  const stdout = screen()
  const stderr = screen()
  const env = { KADEEP_UI: 'rich', COLORTERM: 'truecolor', KADEEP_CONFIG_DIR: dir, KADEEP_API: api.url, HOME: dir }
  const done = startSession({ env, stdin, stdout, stderr })
  const both = () => strip(stdout.out + stderr.out)
  return {
    dir,
    stdin,
    stdout,
    stderr,
    done,
    /** @param {...string} keys */
    type: (...keys) => keys.forEach((k) => stdin.emit('data', k)),
    /** Wait until `text` shows up on stdout, stderr or either, after a `mark()`. */
    async see(text, where = 'any', from = undefined) {
      const end = Date.now() + 5000
      for (;;) {
        const hay = (where === 'out' ? strip(stdout.out) : where === 'err' ? strip(stderr.out) : both()).slice(from?.[where] ?? 0)
        if (typeof text === 'string' ? hay.includes(text) : text.test(hay)) return
        if (Date.now() > end) throw new Error(`Never saw ${text}. Screen:\n${JSON.stringify(both().slice(-1200))}`)
        await new Promise((r) => setTimeout(r, 10))
      }
    },
    /** Where each stream is now, so `see` only looks at what comes after. */
    mark: () => ({ out: strip(stdout.out).length, err: strip(stderr.out).length, any: both().length }),
    /** Wait for the command line to be drawn again. */
    prompt(from) {
      return this.see(/› .*Ask the KaDeep agent|› .*Type \/login/, 'err', from)
    }
  }
}

test('splitArgs: quotes group, backslash escapes', () => {
  assert.deepEqual(splitArgs(`run --suite smoke --test "a b" 'c d' e\\ f`), ['run', '--suite', 'smoke', '--test', 'a b', 'c d', 'e f'])
  assert.deepEqual(splitArgs('ask ""'), ['ask', ''])
})

test('browse: /runs → pick a run → its steps and what next → Esc back, Esc home; the project name is found and kept', async () => {
  const s = session()
  await s.prompt()
  await s.see('Project  KaDeep CLI demo', 'out')
  s.type('/runs', '\r')
  await s.see('Recent runs', 'err')
  let m = s.mark()
  s.type('\u001b[B', '\r')
  await s.see('Expected the Globex heading', 'out')
  await s.see('Ask the agent why it failed', 'err', m)
  m = s.mark()
  s.type('\u001b')
  await s.see('Recent runs', 'err', m)
  m = s.mark()
  s.type('\u001b')
  await s.prompt(m)
  s.type('/exit', '\r')
  assert.equal(await s.done, 0)
  assert.equal(s.stdin.raw, false, 'raw mode off')
  assert.match(s.stderr.out, /\u001b\[\?25h$/, 'cursor shown')
  assert.match(strip(s.stdout.out), /See you/)
  assert.equal(JSON.parse(readFileSync(join(s.dir, 'config.json'), 'utf8')).defaults[api.url].projectName, 'KaDeep CLI demo', '0.1 configs learn the name')
})

test('the agent: plain text is a turn; the reply streams in; Esc stops a long turn on KaDeep and the prompt comes back', async () => {
  const s = session()
  await s.prompt()
  let m = s.mark()
  s.type('why did checkout fail?', '\r')
  await s.see('The heading moved to the tenant picker.', 'out')
  await s.see('Run r2 failed', 'out')
  await s.prompt(m)
  assert.equal(log.turns.at(-1).message, 'why did checkout fail?')
  assert.match(log.turns.at(-1).clientId, /^cli-[0-9a-f-]{36}$/)
  m = s.mark()
  s.type('slow please', '\r')
  await s.see('still working.', 'any', m)
  const stops = log.stops
  s.type('\u001b')
  await s.see('Stopped.', 'out', m)
  assert.equal(log.stops, stops + 1)
  await s.prompt(m)
  s.type('\u0003', '\u0003')
  assert.equal(await s.done, 0, 'Ctrl-C twice exits')
})

test('a live run inside the session: Esc stops waiting (the run goes on), clears the view, and the session lives on', async () => {
  const s = session()
  await s.prompt()
  s.type('/run', '\r')
  await s.see('A suite', 'err')
  s.type('\r')
  await s.see('Smoke', 'err')
  let m = s.mark()
  s.type('\r')
  await s.see('suite Smoke', 'out')
  await s.see('Case 1 of 2', 'err', m)
  m = s.mark()
  s.type('\u001b')
  await s.see('Interrupted.', 'out', m)
  await s.prompt(m)
  s.type('/exit', '\r')
  assert.equal(await s.done, 0)
})

test('search as you type: ↓ and enter open the match', async () => {
  const s = session()
  await s.prompt()
  await new Promise((r) => setTimeout(r, 100))
  s.type('c', 'h', 'e')
  await s.see(/test\s+Checkout heading/, 'err')
  s.type('\u001b[B', '\r')
  await s.see('The Globex heading shows', 'out')
  const m = s.mark()
  s.type('\u001b')
  await s.prompt(m)
  s.type('/exit', '\r')
  assert.equal(await s.done, 0)
})

test('first run without a login: the sign-in steps come first; Ctrl-C there leaves you at the prompt', async () => {
  const s = session({ signedIn: false })
  await s.see('Sign in to KaDeep Studios', 'err')
  await s.see('Email', 'err')
  s.type('\u0003')
  await s.prompt()
  s.type('/exit', '\r')
  assert.equal(await s.done, 0)
})
