// runTests against a stand-in API: the job lifecycle on both lanes, and every way a run must not pass silently.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient, KadeepError, runTests } from '../src/index.mjs'
import { fakeApi, sequence } from './fake-api.mjs'

process.env.KADEEP_POLL_MS = '5'

const run = (id, name, status, extra = {}) => ({ id, name, status, verdict: status === 'passed' ? 'PASS' : 'DEFECT', durationMs: 1000, ...extra })
const ci = (url) => createClient({ api: url, auth: { kind: 'ci', token: 'ts_x' } })
const person = (url) => createClient({ api: url, auth: { kind: 'token', token: 'access' } })

test('CI lane: async run → poll (surviving a 503) → the suite run decides; progress is reported', async () => {
  const api = await fakeApi({
    'POST /api/ci/p1/run': ({ body, headers }) => {
      assert.equal(headers.authorization, 'Bearer ts_x')
      assert.deepEqual(body, { suite: 'smoke', browser: 'firefox', async: true })
      return [202, { ok: true, async: true, jobs: [{ id: 'j1', kind: 'suite', key: 'smoke', target: 'Smoke' }] }]
    },
    'GET /api/ci/p1/jobs/j1': sequence([
      [200, { id: 'j1', status: 'running', done: false, progress: { done: 0, total: 2, message: 'Case 1 of 2' } }],
      [503, { ok: false }],
      [200, { id: 'j1', status: 'completed', done: true, suiteRun: { id: 'sr1', suite: 'Smoke', runs: [run('r1', 'Login', 'passed'), run('r2', 'Pay', 'failed', { error: 'No receipt' })] } }]
    ])
  })
  const progress = []
  const events = []
  const r = await runTests(ci(api.url), { project: 'p1', suite: 'smoke', browser: 'firefox', onProgress: (p) => (progress.push(p.message), events.push(p)) })
  await api.close()
  assert.equal(r.status, 'failed')
  assert.equal(r.lane, 'ci')
  assert.deepEqual([r.passed, r.failed, r.total, r.suiteRunId, r.target], [1, 1, 2, 'sr1', 'Smoke'])
  assert.deepEqual(r.jobs, ['j1'])
  assert.equal(r.runs[1].error, 'No receipt')
  assert.deepEqual([...new Set(progress)], ['running · 0/2 · Case 1 of 2', 'completed'])
  assert.deepEqual([events[0].done, events[0].total, events[0].current], [0, 2, 'Case 1 of 2'], 'structured counts for live views')
  assert.deepEqual(events.at(-1).finished.map((x) => `${x.name}:${x.status}`), ['Login:passed', 'Pay:failed'], 'the CI lane reports finished tests when the job ends')
})

test('CI lane: an API without async runs answers with the finished result, which is used as is', async () => {
  const api = await fakeApi({ 'POST /api/ci/p1/run': () => [200, { ok: true, id: 'sr2', suite: 'Smoke', status: 'passed', runs: [run('r1', 'Login', 'passed')] }] })
  const r = await runTests(ci(api.url), { project: 'p1', suite: 'smoke' })
  await api.close()
  assert.equal(r.status, 'passed')
  assert.deepEqual(r.jobs, [])
})

test('a job that ends without runs is an error; so is an empty suite; neither is a pass', async () => {
  const api = await fakeApi({
    'POST /api/ci/p1/run': () => [202, { ok: true, async: true, jobs: [{ id: 'j9', kind: 'suite', target: 'Smoke' }] }],
    'GET /api/ci/p1/jobs/j9': () => [200, { id: 'j9', status: 'cancelled', done: true, note: 'Cancelled by Ana' }],
    'GET /api/projects/p1/suites': () => [200, [{ id: 's1', key: 'empty', name: 'Empty', flowIds: [] }]],
    'GET /api/projects/p1/suite-runs': () => [200, []],
    'POST /api/projects/p1/suites/s1/run': () => [200, { ok: true, started: true, jobId: 'j2' }],
    'GET /api/jobs/j2': () => [200, { id: 'j2', status: 'completed', result: { suiteRunId: 'sr3', status: 'passed' } }],
    'GET /api/projects/p1/suite-runs/sr3/results': () => [200, { id: 'sr3', suite: 'Empty', runs: [] }]
  })
  const cancelled = await runTests(ci(api.url), { project: 'p1', suite: 'smoke' })
  assert.equal(cancelled.status, 'error')
  assert.match(cancelled.error, /Cancelled by Ana/)
  const empty = await runTests(person(api.url), { project: 'p1', suite: 'empty' })
  await api.close()
  assert.equal(empty.status, 'error')
  assert.equal(empty.ok, false)
  assert.match(empty.error, /No tests ran/)
})

test('session lane, tests: one crashed job makes the result an error even when the other test passed', async () => {
  const api = await fakeApi({
    'GET /api/projects/p1/flows/login': () => [200, { id: 'f1', key: 'login', name: 'Login' }],
    'GET /api/projects/p1/flows/pay': () => [200, { id: 'f2', key: 'pay', name: 'Pay' }],
    'GET /api/projects/p1/runs': () => [200, []],
    'POST /api/projects/p1/flows/f1/run': () => [200, { ok: true, jobId: 'ja' }],
    'POST /api/projects/p1/flows/f2/run': () => [200, { ok: true, jobId: 'jb' }],
    'GET /api/jobs/ja': () => [200, { id: 'ja', status: 'completed', result: { runId: 'r1' } }],
    'GET /api/jobs/jb': () => [200, { id: 'jb', status: 'failed', error: 'Worker lost the browser' }],
    'GET /api/runs/r1': () => [200, { id: 'r1', flowName: 'Login', status: 'passed', verdict: 'PASS' }]
  })
  const r = await runTests(person(api.url), { project: 'p1', tests: ['login', 'pay'] })
  await api.close()
  assert.equal(r.status, 'error')
  assert.equal(r.passed, 1)
  assert.match(r.error, /Worker lost the browser/)
})

test('timeout: stops waiting, says how to follow the job; --no-wait returns the job at once', async () => {
  const api = await fakeApi({
    'POST /api/ci/p1/run': () => [202, { ok: true, async: true, jobs: [{ id: 'j5', kind: 'flow', key: 'login', target: 'Login' }] }],
    'GET /api/ci/p1/jobs/j5': () => [200, { id: 'j5', status: 'running', done: false }]
  })
  const r = await runTests(ci(api.url), { project: 'p1', tests: ['login'], timeoutMs: 40 })
  assert.equal(r.status, 'timeout')
  assert.match(r.error, /kadeep jobs show j5 --wait/)
  const q = await runTests(ci(api.url), { project: 'p1', tests: ['login'], wait: false })
  await api.close()
  assert.deepEqual([q.status, q.ok, q.jobs], ['queued', true, ['j5']])
})

test('errors carry a stable code and exit code: a rejected CI token, an unknown test, KaDeep unreachable', async () => {
  const api = await fakeApi({
    'POST /api/ci/p1/run': ({ body }) => (body.flows ? [404, { ok: false, error: 'Test not found: nope', missing: ['nope'] }] : [401, { ok: false, error: 'Invalid CI token' }])
  })
  await assert.rejects(runTests(ci(api.url), { project: 'p1', suite: 'smoke' }), (e) => e instanceof KadeepError && e.code === 'auth_invalid' && e.exitCode === 2)
  await assert.rejects(runTests(ci(api.url), { project: 'p1', tests: ['nope'] }), (e) => e instanceof KadeepError && e.code === 'not_found' && /nope/.test(e.message))
  await api.close()
  await assert.rejects(runTests(ci(api.url), { project: 'p1', suite: 'smoke' }), (e) => e instanceof KadeepError && e.code === 'network' && e.exitCode === 3)
  await assert.rejects(runTests(ci(api.url), { project: 'p1' }), (e) => e instanceof KadeepError && e.code === 'usage')
})
