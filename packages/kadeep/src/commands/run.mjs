// @ts-check
import { writeFileSync } from 'node:fs'
import { EXIT, usage } from '../errors.mjs'
import { junitXml } from '../junit.mjs'
import { duration } from '../output.mjs'
import { BROWSERS, runTests, VIEWPORTS } from '../ops/run.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/**
 * @param {import('../output.mjs').Output} out
 * @param {import('../ops/run.mjs').RunTestsResult} r
 * @param {string} [junitFile]
 */
export function printRunResult(out, r, junitFile) {
  if (r.status === 'queued') {
    out.line(r.jobs.length ? `Queued: ${r.jobs.join(', ')}. Follow with: kadeep jobs show ${r.jobs[0]} --wait` : 'Started (this KaDeep server runs jobs inline). Check `kadeep runs` for the result.')
    return
  }
  for (const x of r.runs) out.line(`${out.mark(x.status)} ${x.name}${x.verdict && x.verdict !== 'PASS' ? ` [${x.verdict}]` : ''}${x.error ? ` — ${x.error}` : ''}`)
  if (r.error) out.line(out.c.red(r.error))
  if (junitFile) out.line(out.c.dim(`JUnit written to ${junitFile}`))
  out.line(`${r.passed}/${r.total} passed in ${duration(r.durationMs)}${r.suiteRunId ? out.c.dim(`  (suite run ${r.suiteRunId})`) : ''}`)
}

/** @param {import('../output.mjs').Output} out */
export const progressPrinter = (out) => (/** @type {{ message: string }} */ p) => {
  if (!out.json || process.stderr.isTTY) out.note(out.c.dim(`  ${p.message}`))
}

/** @param {Record<string, any>} values */
export function checkRunSettings(values) {
  if (values.browser && !BROWSERS.includes(values.browser)) throw usage(`--browser must be one of ${BROWSERS.join(', ')}`)
  if (values.viewport && !VIEWPORTS.includes(values.viewport)) throw usage(`--viewport must be one of ${VIEWPORTS.join(', ')}`)
}

/** @type {Command} */
const run = {
  name: 'run',
  summary: 'Run a suite or test cases and wait for the verdict',
  usage: [
    'kadeep run --suite <key> [--browser <engine>] [--viewport desktop|laptop|tablet|mobile] [--junit <file>] [--timeout <minutes>]',
    'kadeep run --test <key> [--test <key> …]',
    'kadeep run --suite smoke --no-wait            # queue it, print the job id, return',
    'KADEEP_CI_TOKEN=… kadeep run --project <id> --suite smoke --junit results.xml     # in CI',
    `engines: ${BROWSERS.join(', ')} · default timeout 30 minutes · exit 1 when any test fails`
  ],
  options: {
    suite: { type: 'string' },
    test: { type: 'string', multiple: true },
    flow: { type: 'string', multiple: true },
    browser: { type: 'string' },
    viewport: { type: 'string' },
    junit: { type: 'string' },
    'no-wait': { type: 'boolean' },
    timeout: { type: 'string' }
  },
  async run({ values, out, client, project, api, num }) {
    const tests = [...(values.test ?? []), ...(values.flow ?? [])]
    if (!values.suite && !tests.length) throw usage('Pass --suite <key> or at least one --test <key>')
    if (values.suite && tests.length) throw usage('Pass --suite or --test, not both')
    checkRunSettings(values)
    const c = client('run')
    const p = await project(c)
    if (!out.json) out.note(`KaDeep: running ${values.suite ? `suite ${values.suite}` : tests.join(', ')} in ${p.name ?? p.id} on ${api} …`)
    const result = await runTests(c, {
      project: p.id,
      suite: values.suite,
      tests,
      browser: values.browser,
      viewport: values.viewport,
      wait: !values['no-wait'],
      timeoutMs: (num('timeout') ?? 30) * 60_000,
      onProgress: progressPrinter(out)
    })
    if (values.junit && result.status !== 'queued') writeFileSync(values.junit, junitXml([{ name: result.target, error: result.error, runs: result.runs }]))
    out.result(result, () => printRunResult(out, result, values.junit))
    return result.ok ? EXIT.OK : EXIT.FAILED
  }
}

export default [run]
