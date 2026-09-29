// @ts-check
import { runAndShow } from '../commands/run.mjs'
import { runOption } from '../commands/browse.mjs'
import { KadeepError } from '../errors.mjs'
import { getRun, getSuiteRun, getTest, listIssues, listRuns, listSuiteRuns, listSuites, listTests } from '../ops/browse.mjs'
import { BACK, createPrompts, withSpinner, wrap } from '../ui/index.mjs'
import { ago, printIssue, printRun, printSuiteRun, printTest } from '../views/details.mjs'

/**
 * The session's screens: every list is a picker, every record opens with what you can do next, so nothing needs an
 * id copied. A screen returns where to go: `back` (the screen before it) or `home` (the prompt).
 *
 * Screens are made per interaction with that interaction's output and AbortSignal: Esc or Ctrl-C while something
 * loads or runs aborts it, and every wait below gives up at once (`until`).
 *
 * @typedef {'back' | 'home'} Nav
 * @typedef {import('../output.mjs').Output} Output
 * @typedef {{
 *   out: Output,
 *   client: () => import('../client.mjs').Client,
 *   project: () => { id: string, name?: string },
 *   api: string,
 *   talk: (text: string) => Promise<void>,
 *   ran: () => void
 * }} App
 */

/**
 * Wait for `p`, or give up the moment `signal` aborts (whatever `p` was doing carries on, unseen).
 * @template T
 * @param {AbortSignal | undefined} signal
 * @param {Promise<T>} p
 * @returns {Promise<T>}
 */
export function until(signal, p) {
  if (!signal) return p
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new KadeepError('Cancelled', { code: 'cancelled', exitCode: 130 }))
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/**
 * @param {App} app
 * @param {AbortSignal} signal
 */
export function createScreens(app, signal) {
  const { out } = app
  const { style, g } = out.ui
  const p = createPrompts(out.ui)
  const HOME = { label: 'Home', value: 'home', hint: 'back to the prompt' }
  const BACK_ITEM = { label: 'Back', value: 'back' }

  /** @template T @param {string} label @param {() => Promise<T>} fn */
  const load = (label, fn) => until(signal, withSpinner(out.ui, label, fn))
  /** @template T @param {Promise<T>} x */
  const wait = (x) => until(signal, x)
  /** @param {string} text */
  const note = (text) => out.line(style.muted(`  ${text}`))
  /** A heading line for a screen. @param {string} text */
  const title = (text) => out.line(`\n${style.accent(g.dot)} ${style.bold(text)}`)

  /**
   * Run a suite or tests with the live dot view, then offer what to do with the result.
   * @param {{ suite?: string, tests?: string[], label: string }} what
   * @returns {Promise<Nav>}
   */
  async function runIt(what) {
    for (;;) {
      out.line()
      const result = await wait(runAndShow(out, app.client(), { project: app.project(), api: app.api, suite: what.suite, tests: what.tests, label: what.label, signal }))
      app.ran()
      if (result.status === 'queued') return 'back'
      const failed = result.runs.filter((r) => r.status !== 'passed')
      out.line()
      const next = await wait(
        p.pick({
          message: 'Next',
          options: [
            ...(failed.length ? [{ label: failed.length === 1 ? `Open the failed run: ${failed[0].name}` : `Open one of the ${failed.length} failed runs`, value: 'failed' }] : []),
            ...(failed.length ? [{ label: 'Ask the agent about the failures', value: 'ask' }] : []),
            ...(result.suiteRunId ? [{ label: 'Open the suite run', value: 'suiteRun' }] : []),
            { label: 'Run it again', value: 'again' },
            BACK_ITEM,
            HOME
          ]
        })
      )
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      if (next === 'again') continue
      if (next === 'ask') {
        await app.talk(`These tests just failed in ${what.label}: ${failed.map((r) => `"${r.name}" (run ${r.id}${r.verdict ? `, ${r.verdict}` : ''})`).join(', ')}. For each, is it a real defect or a test problem, and what should I do next?`)
        return 'home'
      }
      if (next === 'suiteRun' && result.suiteRunId) {
        if ((await suiteRun(result.suiteRunId)) === 'home') return 'home'
        continue
      }
      const id = failed.length === 1 ? failed[0].id : await wait(p.pick({ message: 'Failed runs', options: failed.map((r) => ({ label: `${out.mark(r.status)} ${r.name}`, value: r.id, hint: r.verdict ?? r.status })) }))
      if (id === BACK) continue
      if ((await run(/** @type {string} */ (id))) === 'home') return 'home'
      return 'back'
    }
  }

  /** @param {{ test?: string, title?: string }} [q] @returns {Promise<Nav>} */
  async function runs(q = {}) {
    for (;;) {
      const rows = await load('Loading runs', () => listRuns(app.client(), app.project().id, { test: q.test, limit: 40 }))
      if (!rows.length) {
        note('No runs yet. Start one with /run.')
        return 'back'
      }
      const id = await wait(p.pick({ message: q.title ?? 'Recent runs', options: rows.map(runOption(out)), maxVisible: 10 }))
      if (id === BACK) return 'back'
      if ((await run(id)) === 'home') return 'home'
    }
  }

  /** One run, step by step, then what to do with it. @param {string} id @returns {Promise<Nav>} */
  async function run(id) {
    let first = true
    for (;;) {
      const r = await load('Loading the run', () => getRun(app.client(), id))
      if (first) {
        out.line()
        printRun(out, r)
      } else title(`${r.test}  ${style.muted(r.id)}`)
      first = false
      const failed = r.status !== 'passed'
      out.line()
      const next = await wait(
        p.pick({
          message: 'Next',
          options: [
            ...(failed ? [{ label: 'Ask the agent why it failed', value: 'ask' }] : []),
            ...(r.testId ? [{ label: 'Run this test again', value: 'rerun' }, { label: 'Open the test case', value: 'test' }] : []),
            ...(r.suiteRunId ? [{ label: 'Open its suite run', value: 'suiteRun' }] : []),
            ...(!failed ? [{ label: 'Ask the agent about this run', value: 'ask' }] : []),
            BACK_ITEM,
            HOME
          ]
        })
      )
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      if (next === 'ask') {
        await app.talk(failed ? `Why did run ${r.id} of "${r.test}" fail? Look at its steps and evidence: is it a real defect or a problem with the test, and what should I do next?` : `Summarize run ${r.id} of "${r.test}": what did it check, and is there anything worth a closer look?`)
        return 'home'
      }
      /** @type {Nav} */
      let nav = 'back'
      if (next === 'rerun') nav = await runIt({ tests: [r.testId], label: r.test })
      else if (next === 'test') nav = await test(r.testId)
      else if (next === 'suiteRun') nav = await suiteRun(r.suiteRunId)
      if (nav === 'home') return 'home'
    }
  }

  /** @returns {Promise<Nav>} */
  async function suites() {
    for (;;) {
      const rows = await load('Loading suites', () => listSuites(app.client(), app.project().id))
      if (!rows.length) {
        note('No suites in this project yet. Create them in KaDeep Studios, or ask the agent.')
        return 'back'
      }
      const s = await wait(p.pick({ message: 'Suites', options: rows.map((x) => ({ label: x.name, value: x, hint: [`${x.tests} test${x.tests === 1 ? '' : 's'}`, x.lastRunStatus ? `last ${x.lastRunStatus}` : 'never run', x.key].join(' · ') })) }))
      if (s === BACK) return 'back'
      if ((await suite(s)) === 'home') return 'home'
    }
  }

  /** @param {any} s @returns {Promise<Nav>} */
  async function suite(s) {
    title(s.name)
    note([`${s.tests} test${s.tests === 1 ? '' : 's'}`, s.lastRunStatus ? `last run ${s.lastRunStatus}` : 'never run', s.key].join(' · '))
    if (s.description) out.lines(wrap(s.description, out.ui.term.columns - 1, { indent: '  ' }).map((l) => style.muted(l)))
    for (;;) {
      out.line()
      const next = await wait(p.pick({ message: 'Next', options: [{ label: 'Run this suite', value: 'run' }, { label: 'Its test cases', value: 'tests' }, { label: 'Its suite runs', value: 'suiteRuns' }, BACK_ITEM, HOME] }))
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      const nav = next === 'run' ? await runIt({ suite: s.key, label: `suite ${s.name}` }) : next === 'tests' ? await tests({ suite: s.key, title: `Tests in ${s.name}` }) : await suiteRuns({ suite: s.key, title: `Runs of ${s.name}` })
      if (nav === 'home') return 'home'
    }
  }

  /** @param {{ suite?: string, title?: string }} [q] @returns {Promise<Nav>} */
  async function tests(q = {}) {
    for (;;) {
      const rows = await load('Loading test cases', () => listTests(app.client(), app.project().id, { suite: q.suite }))
      if (!rows.length) {
        note('No test cases here yet. Ask the agent to write some.')
        return 'back'
      }
      const key = await wait(p.pick({ message: q.title ?? 'Test cases', options: rows.map((t) => ({ label: `${out.mark(t.lastRunStatus ?? 'queued')} ${t.name}`, value: t.key, hint: [t.lastRunStatus ?? 'never run', t.priority, t.key].filter(Boolean).join(' · ') })), maxVisible: 10 }))
      if (key === BACK) return 'back'
      if ((await test(key)) === 'home') return 'home'
    }
  }

  /** @param {string} key @returns {Promise<Nav>} */
  async function test(key) {
    let first = true
    for (;;) {
      const t = await load('Loading the test case', () => getTest(app.client(), app.project().id, key))
      if (first) {
        out.line()
        printTest(out, t)
      } else title(t.name)
      first = false
      out.line()
      const next = await wait(
        p.pick({
          message: 'Next',
          options: [{ label: 'Run it', value: 'run' }, { label: 'Its recent runs', value: 'runs' }, ...(t.lastRunId ? [{ label: 'Open its last run', value: 'last' }] : []), { label: 'Ask the agent about it', value: 'ask' }, BACK_ITEM, HOME]
        })
      )
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      if (next === 'ask') {
        await app.talk(`Tell me about the test case "${t.name}" (${t.key}): what it covers, how it has been doing lately, and anything that should be improved.`)
        return 'home'
      }
      const nav = next === 'run' ? await runIt({ tests: [t.key], label: t.name }) : next === 'last' ? await run(t.lastRunId) : await runs({ test: t.id, title: `Runs of ${t.name}` })
      if (nav === 'home') return 'home'
    }
  }

  /** @param {{ suite?: string, title?: string }} [q] @returns {Promise<Nav>} */
  async function suiteRuns(q = {}) {
    for (;;) {
      const rows = await load('Loading suite runs', () => listSuiteRuns(app.client(), app.project().id, { suite: q.suite, limit: 30 }))
      if (!rows.length) {
        note('No suite runs yet.')
        return 'back'
      }
      const id = await wait(p.pick({ message: q.title ?? 'Suite runs', options: rows.map((r) => ({ label: `${out.mark(r.status)} ${r.suite}`, value: r.id, hint: `${r.passed} passed · ${r.failed} failed · ${ago(r.startedAt)}` })), maxVisible: 10 }))
      if (id === BACK) return 'back'
      if ((await suiteRun(id)) === 'home') return 'home'
    }
  }

  /** @param {string} id @returns {Promise<Nav>} */
  async function suiteRun(id) {
    const sr = await load('Loading the suite run', () => getSuiteRun(app.client(), app.project().id, id))
    out.line()
    printSuiteRun(out, sr)
    for (;;) {
      const runsIn = sr.runs ?? []
      out.line()
      const next = await wait(p.pick({ message: 'Open a run', options: [...runsIn.map((/** @type {any} */ r) => ({ label: `${out.mark(r.status)} ${r.name}`, value: r.id, hint: r.verdict && r.verdict !== 'PASS' ? r.verdict : r.status })), BACK_ITEM, HOME], maxVisible: 10 }))
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      if ((await run(next)) === 'home') return 'home'
    }
  }

  /** @returns {Promise<Nav>} */
  async function issues() {
    for (;;) {
      const rows = await load('Loading issues', () => listIssues(app.client(), app.project().id))
      if (!rows.length) {
        note('No issues. KaDeep files them when a run finds a defect.')
        return 'back'
      }
      const i = await wait(p.pick({ message: 'Issues', options: rows.map((x) => ({ label: x.title, value: x, hint: [x.severity, x.status, ago(x.createdAt)].filter(Boolean).join(' · ') })), maxVisible: 10 }))
      if (i === BACK) return 'back'
      if ((await issue(i)) === 'home') return 'home'
    }
  }

  /** @param {any} i @returns {Promise<Nav>} */
  async function issue(i) {
    out.line()
    printIssue(out, i)
    for (;;) {
      out.line()
      const next = await wait(p.pick({ message: 'Next', options: [...(i.runId ? [{ label: 'Open the run that found it', value: 'run' }] : []), ...(i.testId ? [{ label: 'Open the test case', value: 'test' }] : []), { label: 'Ask the agent about it', value: 'ask' }, BACK_ITEM, HOME] }))
      if (next === BACK || next === 'back') return 'back'
      if (next === 'home') return 'home'
      if (next === 'ask') {
        await app.talk(`Tell me about issue ${i.id} ("${i.title}"): what fails, how to reproduce it, and how serious it is.`)
        return 'home'
      }
      const nav = next === 'run' ? await run(i.runId) : await test(i.testId)
      if (nav === 'home') return 'home'
    }
  }

  /** `/run` with nothing else: pick a suite or a test case, then run it. @returns {Promise<Nav>} */
  async function runWizard() {
    const what = await wait(p.pick({ message: 'Run', options: [{ label: 'A suite', value: 'suite' }, { label: 'A test case', value: 'test' }] }))
    if (what === BACK) return 'back'
    if (what === 'suite') {
      const rows = await load('Loading suites', () => listSuites(app.client(), app.project().id))
      if (!rows.length) return note('No suites in this project yet.'), 'back'
      const s = await wait(p.pick({ message: 'Suite', options: rows.map((x) => ({ label: x.name, value: x, hint: `${x.tests} tests · ${x.key}` })) }))
      if (s === BACK) return 'back'
      return runIt({ suite: s.key, label: `suite ${s.name}` })
    }
    const rows = await load('Loading test cases', () => listTests(app.client(), app.project().id))
    if (!rows.length) return note('No test cases in this project yet.'), 'back'
    const t = await wait(p.pick({ message: 'Test case', options: rows.map((x) => ({ label: x.name, value: x, hint: x.key })), maxVisible: 10 }))
    if (t === BACK) return 'back'
    return runIt({ tests: [t.key], label: t.name })
  }

  /**
   * Open something found by search or made by the agent.
   * @param {{ kind: string, id: string, key?: string, item?: any }} v
   * @returns {Promise<Nav>}
   */
  async function open(v) {
    if (v.kind === 'run') return run(v.id)
    if (v.kind === 'test') return test(v.key ?? v.id)
    if (v.kind === 'suite') return suite(v.item)
    if (v.kind === 'issue') return issue(v.item)
    return 'back'
  }

  /**
   * A list to pick from, then open the pick (search results, what the agent touched).
   * @param {string} message
   * @param {Array<{ label: string, hint?: string, kind: string, value: any }>} items
   * @returns {Promise<Nav>}
   */
  async function choose(message, items) {
    for (;;) {
      const v = await wait(p.pick({ message, options: items.map((x) => ({ label: `${style.muted(x.kind.padEnd(6))} ${x.label}`, value: x.value, hint: x.hint })), maxVisible: 10 }))
      if (v === BACK) return 'back'
      if ((await open(v)) === 'home') return 'home'
    }
  }

  return { runs, run, suites, suite, tests, test, suiteRuns, suiteRun, issues, issue, runWizard, open, choose }
}
