// Output contracts by mode, on the real bin: CI and pipes get exactly the 0.1 lines with no escape sequences, --json
// stays one document, MCP stdout stays protocol-only, and the rich UI (live region, box, animation) appears only where
// it belongs.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeApi, sequence } from './fake-api.mjs'

const BIN = new URL('../bin/kadeep.mjs', import.meta.url).pathname
const ESC = /\u001b/
const SGR = /\u001b\[[0-9;]*m/
let api

const RUNS = { r1: ['Login works', 'passed'], r2: ['Search works', 'failed'], r3: ['Checkout works', 'passed'], r4: ['Profile loads', 'passed'] }
const run = (id) => ({ id, flowName: RUNS[id][0], status: RUNS[id][1], verdict: RUNS[id][1] === 'passed' ? 'PASS' : 'DEFECT', durationMs: 9000, error: RUNS[id][1] === 'passed' ? undefined : 'Expected the results list' })
const job = (done, ids, status = 'running') => [200, { id: 'job_1', kind: 'suite', status, progress: { done, total: 4, message: `Case ${done + 1} of 4` }, checkpoint: { completedRunIds: ids }, ...(status === 'completed' ? { result: { suiteRunId: 'sr_1' } } : {}) }]
const jobs = () => sequence([job(0, []), job(2, ['r1', 'r2']), job(4, ['r1', 'r2', 'r3', 'r4'], 'completed')])

before(async () => {
  let poll = jobs()
  api = await fakeApi({
    'GET /api/projects': () => [200, [{ id: 'p1', name: 'Demo' }]],
    'GET /api/projects/p1/suites': () => [200, [{ id: 's1', key: 'smoke', name: 'Smoke', flowIds: ['a', 'b', 'c', 'd'] }]],
    'GET /api/projects/p1/suite-runs': () => [200, []],
    'POST /api/projects/p1/suites/s1/run': () => ((poll = jobs()), [200, { ok: true, jobId: 'job_1' }]),
    'GET /api/jobs/job_1': () => poll(),
    ...Object.fromEntries(Object.keys(RUNS).map((id) => [`GET /api/runs/${id}`, () => [200, run(id)]])),
    'GET /api/projects/p1/suite-runs/sr_1/results': () => [200, { id: 'sr_1', suite: 'Smoke', runs: Object.keys(RUNS).map((id) => ({ ...run(id), name: RUNS[id][0] })) }]
  })
})
after(() => api.close())

/** @returns {Promise<{ status: number, stdout: string, stderr: string, dir: string }>} */
function kadeep(args, env = {}, input) {
  const dir = env.KADEEP_CONFIG_DIR ?? mkdtempSync(join(tmpdir(), 'kadeep-modes-'))
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { env: { PATH: process.env.PATH, HOME: dir, KADEEP_CONFIG_DIR: dir, KADEEP_API: api.url, KADEEP_TOKEN: 'tok', KADEEP_POLL_MS: '20', ...env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    if (input) child.stdin.end(input)
    child.on('close', (status) => done({ status, stdout, stderr, dir }))
  })
}

test('CI and pipes: exactly the 0.1 lines, and not one escape sequence on stdout or stderr', async () => {
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, {}]) {
    const r = await kadeep(['run', '--project', 'p1', '--suite', 'smoke'], env)
    assert.equal(r.status, 1)
    assert.doesNotMatch(r.stdout + r.stderr, ESC, JSON.stringify(env))
    assert.match(r.stdout, /^✓ Login works\n✗ Search works \[DEFECT\] — Expected the results list\n✓ Checkout works\n✓ Profile loads\n3\/4 passed in \d+s {2}\(suite run sr_1\)\n$/)
    assert.match(r.stderr, /^KaDeep: running suite smoke in Demo on http/)
  }
})

test('--json is one document on stdout, even when rich output is forced', async () => {
  const r = await kadeep(['run', '--project', 'p1', '--suite', 'smoke', '--json'], { KADEEP_UI: 'rich' })
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).status, 'failed')
  assert.doesNotMatch(r.stdout, ESC)
})

test('rich: a live region on stderr (cursor hidden, then restored), results and a summary box on stdout', async () => {
  const r = await kadeep(['run', '--project', 'p1', '--suite', 'smoke'], { KADEEP_UI: 'rich', COLORTERM: 'truecolor' })
  assert.equal(r.status, 1)
  assert.match(r.stderr, /\u001b\[\?25l/)
  assert.match(r.stderr, /\u001b\[\?25h$/)
  const plain = r.stdout.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.match(plain, /● KaDeep · suite smoke · Demo/)
  assert.match(plain, /✖ Search works {2}DEFECT {2}Expected the results list/)
  assert.match(plain, /● ● ● ● {3}4\/4 · 1 failed/)
  assert.match(plain, /╭─+╮\n│ ✖ 3\/4 passed · \d+s · suite run sr_1 │\n╰─+╯/)
  assert.match(r.stdout, /\u001b\[38;2;239;68;68m/, 'failure in the palette red')
})

test('NO_COLOR keeps the rich layout but drops every color', async () => {
  const r = await kadeep(['run', '--project', 'p1', '--suite', 'smoke'], { KADEEP_UI: 'rich', NO_COLOR: '1' })
  assert.doesNotMatch(r.stdout + r.stderr, SGR)
  assert.match(r.stdout, /╭/)
})

test('kadeep mcp: stdout is JSON-RPC only, even when rich output is forced', async () => {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ]
  const r = await kadeep(['mcp'], { KADEEP_UI: 'rich', COLORTERM: 'truecolor' }, msgs.map((m) => JSON.stringify(m)).join('\n') + '\n')
  const lines = r.stdout.trim().split('\n')
  assert.equal(lines.length, 2)
  for (const l of lines) assert.equal(JSON.parse(l).jsonrpc, '2.0')
})

test('welcome: plain help when piped; in rich mode the dot-fill runs once, then never again', async () => {
  const piped = await kadeep([])
  assert.match(piped.stdout, /^kadeep \d+\.\d+\.\d+: KaDeep Studios/)
  assert.doesNotMatch(piped.stdout + piped.stderr, ESC)
  assert.equal(existsSync(join(piped.dir, 'config.json')), false, 'nothing is remembered outside rich mode')

  const first = await kadeep([], { KADEEP_UI: 'rich', COLORTERM: 'truecolor' })
  assert.match(first.stderr, /\u001b\[\?25l/, 'the animation drew on stderr')
  assert.equal(JSON.parse(readFileSync(join(first.dir, 'config.json'), 'utf8')).ui.welcomeSeen, true)
  const again = await kadeep([], { KADEEP_UI: 'rich', COLORTERM: 'truecolor', KADEEP_CONFIG_DIR: first.dir })
  assert.doesNotMatch(again.stderr, /\u001b\[\?25l/, 'no animation the second time')
  assert.match(again.stdout.replace(/\u001b\[[0-9;]*m/g, ''), /● ● {5}● ● {5}● ● ● ● ●/, 'the logo, drawn at once')

  const noColor = await kadeep([], { KADEEP_UI: 'rich', NO_COLOR: '1' })
  assert.doesNotMatch(noColor.stderr, /\u001b\[\?25l/, 'no animation without colors')
})
