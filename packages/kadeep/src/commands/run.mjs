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
  async run({ values, out, client, project, api, num, signal }) {
    const tests = [...(values.test ?? []), ...(values.flow ?? [])]
    if (!values.suite && !tests.length) throw usage('Pass --suite <key> or at least one --test <key>')
    if (values.suite && tests.length) throw usage('Pass --suite or --test, not both')
    checkRunSettings(values)
    const c = client('run')
    const p = await project(c)
    const result = await runAndShow(out, c, { project: p, api, suite: values.suite, tests, browser: values.browser, viewport: values.viewport, wait: !values['no-wait'], timeoutMs: (num('timeout') ?? 30) * 60_000, junit: values.junit, signal })
    return result.ok ? EXIT.OK : EXIT.FAILED
  }
}

/**
 * Run and show it: the live view while it runs, the JUnit file, the verdict. `kadeep run` and the interactive
 * session both use it; aborting `signal` stops waiting (the run carries on on KaDeep) and clears the view.
 * @param {import('../output.mjs').Output} out
 * @param {import('../client.mjs').Client} c
 * @param {{ project: { id: string, name?: string }, api: string, suite?: string, tests?: string[], browser?: string, viewport?: string, wait?: boolean, timeoutMs?: number, junit?: string, signal?: AbortSignal, label?: string }} o
 */
export async function runAndShow(out, c, o) {
  const tests = o.tests ?? []
  const what = o.label ?? (o.suite ? `suite ${o.suite}` : tests.join(', '))
  if (!out.json && !out.rich) out.note(`KaDeep: running ${what} in ${o.project.name ?? o.project.id} on ${o.api} …`)
  const view = runView(out, { title: `${what} ${out.c.muted('·')} ${o.project.name ?? o.project.id}`, total: o.suite ? undefined : tests.length })
  try {
    const result = await runTests(c, { project: o.project.id, suite: o.suite, tests, browser: o.browser, viewport: o.viewport, wait: o.wait, timeoutMs: o.timeoutMs, onProgress: view.progress, signal: o.signal })
    if (o.junit && result.status !== 'queued') writeFileSync(o.junit, junitXml([{ name: result.target, error: result.error, runs: result.runs }]))
    view.done(result, o.junit)
    return result
  } catch (err) {
    view.stop()
    throw err
  }
}

export default [run]
