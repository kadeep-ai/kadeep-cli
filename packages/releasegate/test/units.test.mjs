// Pure pieces of releasegate: policy validation, verdict → exit code, report rendering. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { annotations, exitCode, junit, markdown, parsePolicy, PolicyError } from '../src/index.mjs'

const ok = (text) => parsePolicy(text, 'releasegate.yml')
const problems = (text) => {
  try {
    ok(text)
  } catch (err) {
    assert.ok(err instanceof PolicyError)
    return err.problems
  }
  assert.fail('expected a PolicyError')
}

test('a full policy parses with defaults filled in', () => {
  const p = ok(`version: 1
project: p1
mode: shadow
checks:
  - suite: smoke
    browser: firefox
  - name: Checkout
    tests: checkout
    required: false
    timeoutMinutes: 10
  - localization: { locales: [hi-IN], minCoverage: 95, minMqm: 8 }
report: { dir: out, junit: false }
`)
  assert.equal(p.mode, 'shadow')
  assert.deepEqual(p.checks.map((c) => [c.name, c.type, c.required, c.timeoutMinutes]), [['Suite smoke', 'suite', true, 30], ['Checkout', 'tests', false, 10], ['Localization', 'localization', true, 30]])
  assert.equal(p.checks[0].browser, 'firefox')
  assert.deepEqual(p.checks[1].tests, ['checkout'])
  assert.deepEqual(p.checks[2].localization, { requireApproved: true, locales: ['hi-IN'], minCoverage: 95, minMqm: 8 })
  assert.deepEqual(p.report, { dir: 'out', junit: false, markdown: true })
  assert.equal(ok('project: p\nchecks: [{ suite: s }]\n').mode, 'enforce', 'enforce unless the policy says shadow')
})

test('every problem is reported at once, with did-you-mean for typos', () => {
  const found = problems(`version: 2
projcet: p1
mode: loud
checks:
  - suit: smoke
  - suite: a
    tests: [b]
  - tests: []
  - localization: { minCoverage: 120, locale: hi-IN }
  - suite: s
    viewport: huge
`)
  assert.deepEqual(found, [
    'unknown key "projcet" (did you mean "project"?)',
    'version must be 1 (got 2)',
    'mode must be enforce or shadow (got "loud")',
    'checks[0]: unknown key "suit" (did you mean "suite"?)',
    'checks[0] needs exactly one of suite, tests or localization',
    'checks[1] needs exactly one of suite, tests or localization',
    'checks[2].tests must be a list of test keys',
    'checks[3].localization: unknown key "locale" (did you mean "locales"?)',
    'checks[3].localization.minCoverage must be 0–100',
    'checks[4].viewport must be one of desktop, laptop, tablet, mobile'
  ])
  assert.deepEqual(problems('project: p\nchecks: []\n'), ['checks is empty: add at least one suite, tests or localization check'])
  assert.throws(() => ok('checks: [\n'), /not valid YAML/)
  assert.equal(parsePolicy('{"project":"p","checks":[{"suite":"s"}]}', 'releasegate.json').checks[0].suite, 's')
})

test('a broken policy still tells the CLI which mode it asked for', () => {
  assert.throws(() => ok('mode: shadow\nchecks: []\n'), (err) => err instanceof PolicyError && err.mode === 'shadow')
})

const report = (over = {}) => ({
  tool: 'KaDeep Release Gate',
  version: '0.1.0',
  kadeep: '0.1.0',
  verdict: 'NO-GO',
  mode: 'enforce',
  blocking: true,
  project: 'p1',
  api: 'https://api.kadeep.ai',
  commit: { provider: 'github', ci: true, commit: 'abcdef1234567', branch: 'main', pr: '3', runUrl: 'https://ci/run' },
  startedAt: '',
  finishedAt: '',
  durationMs: 65_000,
  checks: [
    { name: 'Smoke', type: 'suite', required: true, status: 'failed', summary: '1/2 passed', durationMs: 60_000, runs: [{ id: 'r1', name: 'Login', status: 'passed' }, { id: 'r2', name: 'Pay | card', status: 'failed', verdict: 'DEFECT', error: 'No receipt' }] },
    { name: 'Hindi', type: 'localization', required: false, status: 'failed', summary: 'hi-IN: coverage 80% below 100%', durationMs: 50, locales: ['hi-IN'] }
  ],
  ...over
})

test('exit codes: shadow never blocks; enforce is 0 GO, 1 NO-GO, 2/3 for setup errors', () => {
  assert.equal(exitCode(report({ verdict: 'GO' })), 0)
  assert.equal(exitCode(report()), 1)
  assert.equal(exitCode(report({ mode: 'shadow' })), 0)
  assert.equal(exitCode(report({ verdict: 'ERROR', errorExit: 3 })), 3)
  assert.equal(exitCode(report({ verdict: 'ERROR' })), 2)
  assert.equal(exitCode(report({ verdict: 'ERROR', mode: 'shadow', errorExit: 3 })), 0)
})

test('markdown, junit and annotations', () => {
  const md = markdown(report())
  assert.match(md, /^## KaDeep Release Gate: ❌ NO-GO$/m)
  assert.match(md, /commit `abcdef1` on main PR #3 · project `p1` · mode enforce · 1m 5s/)
  assert.match(md, /\| Smoke \| yes \| ❌ failed \| 1\/2 passed \|/)
  assert.match(md, /\| Hindi \| advisory \| ❌ failed \|/)
  assert.match(md, /\*\*Pay \| card\*\* \(Smoke\) `DEFECT`: No receipt/)
  assert.match(md, /Engineering release confidence\./)
  assert.match(markdown(report({ mode: 'shadow' })), /⚠️ NO-GO \(shadow mode: not blocking\)/)
  const xml = junit(report())
  assert.match(xml, /<testsuite name="Hindi" tests="1" failures="1"/)
  assert.deepEqual(annotations(report()), ['::error title=KaDeep Release Gate: Smoke::1/2 passed', '::warning title=KaDeep Release Gate: Hindi::hi-IN: coverage 80%25 below 100%25'])
  assert.ok(annotations(report({ mode: 'shadow' })).at(-1).startsWith('::warning title=KaDeep Release Gate::Would have blocked'))
})
