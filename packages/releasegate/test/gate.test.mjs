// The releasegate bin end to end against a stand-in API: verdicts, modes, exit codes and the written report.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeApi } from '../../kadeep/test/fake-api.mjs'

const BIN = new URL('../bin/releasegate.mjs', import.meta.url).pathname
const run = (name, status) => ({ id: `r-${name}`, name, status, verdict: status === 'passed' ? 'PASS' : 'DEFECT', durationMs: 900, error: status === 'passed' ? undefined : `${name} broke` })
let api

before(async () => {
  api = await fakeApi({
    'POST /api/ci/p1/run': ({ body, headers }) => (headers.authorization !== 'Bearer ts_good' ? [401, { ok: false, error: 'Invalid CI token' }] : [202, { ok: true, async: true, jobs: [{ id: `job-${body.suite}`, kind: 'suite', key: body.suite, target: body.suite }] }]),
    'GET /api/ci/p1/jobs/job-smoke': () => [200, { id: 'job-smoke', status: 'completed', done: true, suiteRun: { id: 'sr1', suite: 'Smoke', runs: [run('Login', 'passed'), run('Search', 'passed')] } }],
    'GET /api/ci/p1/jobs/job-broken': () => [200, { id: 'job-broken', status: 'completed', done: true, suiteRun: { id: 'sr2', suite: 'Broken', runs: [run('Pay', 'failed')] } }],
    'GET /api/ci/p1/loc/validate': ({ query }) => [422, { ok: false, locales: query.getAll('locale'), failures: ['hi-IN: coverage 80% below 100%'] }]
  })
})
after(() => api.close())

/** @param {string} policy @param {string[]} [args] @param {Record<string, string>} [env] */
function gate(policy, args = [], env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'releasegate-'))
  writeFileSync(join(dir, 'releasegate.yml'), policy)
  return new Promise((done) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: dir, env: { PATH: process.env.PATH, HOME: dir, KADEEP_API: api.url, KADEEP_CI_TOKEN: 'ts_good', KADEEP_POLL_MS: '5', NO_COLOR: '1', ...env } })
    let stdout = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.on('close', (code) => {
      const file = join(dir, '.releasegate/report.json')
      done({ status: code, stdout, dir, report: existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : undefined })
    })
  })
}

const policy = (checks, mode = 'enforce') => `version: 1\nproject: p1\nmode: ${mode}\nchecks:\n${checks}`

test('GO: exit 0 and the report files are written', async () => {
  const r = await gate(policy('  - suite: smoke\n'))
  assert.equal(r.status, 0, r.stdout)
  assert.equal(r.report.verdict, 'GO')
  assert.match(r.stdout, /✓ Suite smoke: 2\/2 passed/)
  assert.ok(existsSync(join(r.dir, '.releasegate/report.md')))
  assert.match(readFileSync(join(r.dir, '.releasegate/junit.xml'), 'utf8'), /tests="2" failures="0"/)
})

test('NO-GO blocks in enforce (exit 1) and not in shadow (exit 0); advisory checks never block', async () => {
  const checks = '  - suite: smoke\n  - suite: broken\n  - localization: { locales: [hi-IN] }\n    required: false\n'
  const enforce = await gate(policy(checks))
  assert.equal(enforce.status, 1)
  assert.deepEqual(enforce.report.checks.map((c) => c.status), ['passed', 'failed', 'failed'])
  assert.match(enforce.stdout, /✗ Pay \[DEFECT\] · Pay broke/)
  const shadow = await gate(policy(checks, 'shadow'))
  assert.equal(shadow.status, 0)
  assert.equal(shadow.report.verdict, 'NO-GO')
  assert.equal(shadow.report.blocking, false)
  const advisoryOnly = await gate(policy('  - suite: smoke\n  - localization: { locales: [hi-IN] }\n    required: false\n'))
  assert.equal(advisoryOnly.status, 0)
})

test('setup errors: bad token 2, unreachable 3, broken policy 2 (0 in shadow), missing token names the fix', async () => {
  assert.equal((await gate(policy('  - suite: smoke\n'), [], { KADEEP_CI_TOKEN: 'ts_bad' })).status, 2)
  assert.equal((await gate(policy('  - suite: smoke\n'), [], { KADEEP_API: 'http://127.0.0.1:1' })).status, 3)
  assert.equal((await gate('version: 1\nproject: p1\nchecks:\n  - suit: smoke\n')).status, 2)
  assert.equal((await gate('version: 1\nproject: p1\nmode: shadow\nchecks:\n  - suit: smoke\n')).status, 0)
  const missing = await gate(policy('  - suite: smoke\n'), [], { KADEEP_CI_TOKEN: '', GITHUB_ACTIONS: 'true' })
  assert.equal(missing.status, 2)
  assert.match(missing.stdout, /Add the repository secret KADEEP_CI_TOKEN/)
})

test('rich terminal: a live checklist with dots, then the verdict in large dots; the exit code is unchanged', async () => {
  const r = await gate(policy('  - suite: smoke\n  - suite: broken\n'), [], { KADEEP_UI: 'rich', COLORTERM: 'truecolor', NO_COLOR: '' })
  assert.equal(r.status, 1)
  assert.equal(r.report.verdict, 'NO-GO')
  const out = r.stdout.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
  assert.match(out, /✖ Pay {2}DEFECT\n {4}Pay broke\n/)
  assert.match(out, /●       ● {5}● ● ●/, 'NO-GO in large dots')
  assert.match(out, /1 of 2 required checks passed/)
  assert.match(r.stdout, /\u001b\[38;2;239;68;68m/, 'in the palette red')
})
