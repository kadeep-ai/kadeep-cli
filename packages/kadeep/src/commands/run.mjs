// @ts-check
import { writeFileSync } from 'node:fs'
import { EXIT, usage } from '../errors.mjs'
import { junitXml } from '../junit.mjs'
import { BROWSERS, runTests, VIEWPORTS } from '../ops/run.mjs'
import { runView } from '../views/run-view.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

export { printRunResult } from '../views/run-view.mjs'

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
    const what = values.suite ? `suite ${values.suite}` : tests.join(', ')
    if (!out.json && !out.rich) out.note(`KaDeep: running ${what} in ${p.name ?? p.id} on ${api} …`)
    const view = runView(out, { title: `${what} ${out.c.muted('·')} ${p.name ?? p.id}`, total: values.suite ? undefined : tests.length })
    const result = await runTests(c, {
      project: p.id,
      suite: values.suite,
      tests,
      browser: values.browser,
      viewport: values.viewport,
      wait: !values['no-wait'],
      timeoutMs: (num('timeout') ?? 30) * 60_000,
      onProgress: view.progress
    })
    if (values.junit && result.status !== 'queued') writeFileSync(values.junit, junitXml([{ name: result.target, error: result.error, runs: result.runs }]))
    view.done(result, values.junit)
    return result.ok ? EXIT.OK : EXIT.FAILED
  }
}

export default [run]
