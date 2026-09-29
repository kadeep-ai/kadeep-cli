// Pure pieces of kadeep: CI detection, JUnit, API resolution and auth selection. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciContext, DEFAULT_API, junitXml, KadeepError, resolveApi, resolveAuth, VERSION } from '../src/index.mjs'
import { policyYaml, mcpEntry, planInit, RANGE } from '../src/ops/init.mjs'

test('ciContext reads each provider, and the PR head on GitHub pull requests', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-ci-'))
  const event = join(dir, 'event.json')
  writeFileSync(event, JSON.stringify({ pull_request: { head: { sha: 'abc123head' } } }))
  assert.deepEqual(ciContext({ GITHUB_ACTIONS: 'true', GITHUB_SHA: 'merge', GITHUB_REF: 'refs/pull/7/merge', GITHUB_HEAD_REF: 'feat/x', GITHUB_EVENT_PATH: event, GITHUB_REPOSITORY: 'a/b', GITHUB_RUN_ID: '5' }, { git: false }), { provider: 'github', ci: true, commit: 'abc123head', branch: 'feat/x', pr: '7', repo: 'a/b', runUrl: 'https://github.com/a/b/actions/runs/5' })
  assert.equal(ciContext({ GITHUB_ACTIONS: 'true', GITHUB_SHA: 'push-sha', GITHUB_REF: 'refs/heads/main', GITHUB_REF_NAME: 'main', GITHUB_HEAD_REF: '' }, { git: false }).commit, 'push-sha')
  assert.deepEqual(ciContext({ GITLAB_CI: 'true', CI_COMMIT_SHA: 's', CI_COMMIT_REF_NAME: 'main', CI_JOB_URL: 'u' }, { git: false }), { provider: 'gitlab', ci: true, commit: 's', branch: 'main', runUrl: 'u' })
  assert.equal(ciContext({ CIRCLECI: 'true', CIRCLE_SHA1: 'c', CIRCLE_PULL_REQUEST: 'https://github.com/a/b/pull/12' }, { git: false }).pr, '12')
  assert.equal(ciContext({ BUILDKITE: 'true', BUILDKITE_PULL_REQUEST: 'false', BUILDKITE_COMMIT: 'k' }, { git: false }).pr, undefined)
  assert.deepEqual(ciContext({}, { git: false }), { provider: 'local', ci: false })
})

test('junitXml escapes, counts failures, and turns a run-less error into an errored case', () => {
  const xml = junitXml([
    { name: 'Smoke & more', runs: [{ name: 'a', status: 'passed', durationMs: 1200 }, { name: 'b <x>', status: 'failed', verdict: 'DEFECT', error: 'Expected "ok"' }] },
    { name: 'Empty', error: 'No tests ran', runs: [] }
  ])
  assert.match(xml, /<testsuite name="Smoke &amp; more" tests="2" failures="1" errors="0" time="1\.200">/)
  assert.match(xml, /<testcase classname="Smoke &amp; more" name="b &lt;x&gt;" time="0\.000">\n\s+<failure message="Expected &quot;ok&quot;" type="DEFECT">/)
  assert.match(xml, /<testsuite name="Empty" tests="1" failures="0" errors="1"/)
})

test('resolveApi: flag, then KADEEP_API, then TESTSTUDIOS_API, then the logged-in API, then production', () => {
  assert.equal(resolveApi({ flag: 'http://x/', env: {}, config: {} }), 'http://x')
  assert.equal(resolveApi({ env: { KADEEP_API: 'http://k' }, config: { api: 'http://c' } }), 'http://k')
  assert.equal(resolveApi({ env: { TESTSTUDIOS_API: 'http://t' }, config: {} }), 'http://t')
  assert.equal(resolveApi({ env: {}, config: { api: 'http://c' } }), 'http://c')
  assert.equal(resolveApi({ env: {}, config: {} }), DEFAULT_API)
  assert.equal(DEFAULT_API, 'https://api.kadeep.ai')
})

test('resolveAuth: sessions are per API; run falls back to the CI token; ci needs one', () => {
  const config = { sessions: { 'https://a': { accessToken: 'acc', refreshToken: 'ref' } } }
  assert.deepEqual(resolveAuth('user', { api: 'https://a', env: {}, config }), { kind: 'session', accessToken: 'acc', refreshToken: 'ref' })
  assert.throws(() => resolveAuth('user', { api: 'https://b', env: {}, config }), (e) => e instanceof KadeepError && e.code === 'auth_required', 'a session is never sent to another host')
  assert.deepEqual(resolveAuth('run', { api: 'https://b', env: { KADEEP_CI_TOKEN: 'ci' }, config }), { kind: 'ci', token: 'ci' })
  assert.deepEqual(resolveAuth('run', { api: 'https://a', env: { KADEEP_TOKEN: 'tok' }, config }), { kind: 'token', token: 'tok' })
  assert.deepEqual(resolveAuth('ci', { api: 'https://a', env: { TESTSTUDIOS_CI_TOKEN: 'old' }, config }), { kind: 'ci', token: 'old' })
  assert.throws(() => resolveAuth('ci', { api: 'https://a', env: {}, config }), (e) => e instanceof KadeepError && e.code === 'ci_token_required' && e.exitCode === 2)
})

test('init templates: shadow policy with the suite and locales; MCP entry pins the minor range', () => {
  const yaml = policyYaml({ project: { id: 'p1', name: 'Acme' }, suite: { key: 'smoke', name: 'Smoke: "core"' }, locales: ['hi-IN', 'ar-AE'] })
  assert.match(yaml, /^project: p1 {2}# Acme$/m)
  assert.match(yaml, /^mode: shadow$/m)
  assert.match(yaml, /name: "Smoke: \\"core\\""\n {4}suite: smoke/)
  assert.match(yaml, /locales: \[hi-IN, ar-AE\]/)
  assert.equal(RANGE, `^${VERSION.split('.').slice(0, 2).join('.')}`, 'the minor line of this release')
  assert.deepEqual(mcpEntry({ project: 'p1', api: DEFAULT_API }), { command: 'npx', args: ['-y', `kadeep@${RANGE}`, 'mcp'], env: { KADEEP_PROJECT: 'p1' } })
})

test('init: the workflow is .github/workflows/releasegate.yml with a releasegate job, named after the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kadeep-init-'))
  const writes = planInit({ dir, api: DEFAULT_API, project: { id: 'p1' }, suite: { key: 'smoke', name: 'Smoke' }, ci: 'github', mcp: false, force: false })
  const wf = writes.find((w) => w.path.endsWith('.github/workflows/releasegate.yml'))
  assert.ok(wf, writes.map((w) => w.path).join(', '))
  assert.match(wf.content, /^ {2}releasegate:$/m)
  assert.ok(wf.content.includes(`run: npx -y releasegate@${RANGE}`))
  assert.doesNotMatch(wf.content, /KADEEP_API/, 'the default API is not written into CI')
})
