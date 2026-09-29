// @ts-check
import { resolveProject, routes } from '../api.mjs'
import { updateConfig } from '../config.mjs'
import { usage } from '../errors.mjs'
import { duration } from '../output.mjs'
import { richPrompts } from '../prompt.mjs'
import { getRun, getSuiteRun, getTest, listIssues, listProjects, listRuns, listSuiteRuns, listSuites, listTests } from '../ops/browse.mjs'
import { ago, openHint, printRun, printSuiteRun, printTest, when } from '../views/details.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/**
 * `show` without an id: in an interactive terminal, pick one from the list instead of copying an id.
 * @template T
 * @param {import('../output.mjs').Output} out
 * @param {string} what  for the usage error outside a terminal
 * @param {() => Promise<Array<{ label: string, value: T, hint?: string }>>} load
 * @returns {Promise<T>}
 */
async function pickOne(out, what, load) {
  const rp = richPrompts(out)
  if (!rp) throw usage(what)
  const options = await load()
  if (!options.length) throw usage(`Nothing to show yet. ${what}`)
  return rp.select({ message: 'Open', options, maxVisible: 10 })
}

/** A run as a picker option. @param {import('../output.mjs').Output} out */
export const runOption = (out) => (/** @type {ReturnType<typeof import('../ops/browse.mjs').runRow>} */ r) => ({
  label: `${out.mark(r.status)} ${r.test}`,
  value: r.id,
  hint: [r.verdict && r.verdict !== 'PASS' ? r.verdict : r.status, ago(r.startedAt), duration(r.durationMs), r.id.slice(0, 10)].filter(Boolean).join(' · ')
})

/** @type {Command} */
const projects = {
  name: 'projects',
  summary: 'List your projects (* = default)',
  usage: ['kadeep projects'],
  async run({ out, client, config, api, env }) {
    const rows = await listProjects(client('user'), env.KADEEP_PROJECT || config.defaults?.[api]?.project)
    out.result(rows, () => {
      if (!rows.length) return out.line('No projects yet. Create one in the KaDeep app.')
      const star = out.rich ? out.c.accent(out.ui.g.dot) : '*'
      out.table(['', 'ID', 'NAME', 'KIND', 'URL'], rows.map((p) => [p.default ? star : '', p.id, p.name, p.kind, p.baseUrl ?? '']))
    })
  }
}

/** @type {Command} */
const use = {
  name: 'use',
  summary: 'Set the default project for this API',
  usage: ['kadeep use <project>          # id or name', 'kadeep use                    # pick from a list (type to filter)'],
  async run({ out, client, positionals, api, env, values, config }) {
    const ref = positionals[0] ?? values.project
    const rp = ref ? null : richPrompts(out)
    if (!ref && !rp) throw usage('Pass a project id or name: kadeep use <project>')
    const c = client('user')
    /** @type {{ id: string, name?: string }} */
    let p
    if (rp) {
      /** @type {any[]} */
      const all = await routes.projects(c)
      const current = config.defaults?.[api]?.project
      p = await rp.select({ message: 'Default project', options: all.map((x) => ({ label: x.name, value: x, hint: [x.id, x.baseUrl].filter(Boolean).join('  ') })), initial: Math.max(0, all.findIndex((x) => x.id === current)) })
    } else p = await resolveProject(c, { ref, env: { ...env, KADEEP_PROJECT: undefined } })
    updateConfig((cfg) => {
      cfg.defaults ??= {}
      cfg.defaults[api] = { ...cfg.defaults[api], project: p.id, projectName: p.name }
    }, env)
    out.result({ ok: true, api, project: { id: p.id, name: p.name } }, () => out.line(`Default project: ${p.name} (${p.id})`))
  }
}

/** @type {Command} */
const suites = {
  name: 'suites',
  summary: 'List the suites in a project',
  usage: ['kadeep suites [--project <p>]'],
  async run({ out, client, project }) {
    const c = client('user')
    const p = await project(c)
    const rows = await listSuites(c, p.id)
    out.result(rows, () => {
      if (!rows.length) return out.line('No suites in this project yet.')
      out.table(['KEY', 'TESTS', 'LAST RUN', 'NAME'], rows.map((s) => [s.key, s.tests, out.status(s.lastRunStatus), s.name]))
    })
  }
}

/** @type {Command} */
const tests = {
  name: 'tests',
  aliases: ['flows', 'test-cases'],
  summary: 'List test cases, or show one',
  usage: ['kadeep tests [--suite <key>] [--label <label>] [--search <text>]', 'kadeep tests show [<test>]      # key, id or name; without one, pick from the list'],
  options: { suite: { type: 'string' }, label: { type: 'string' }, search: { type: 'string' } },
  async run({ out, client, project, positionals, values }) {
    const c = client('user')
    const p = await project(c)
    if (positionals[0] === 'show') {
      const key = positionals[1] ?? (await pickOne(out, 'Pass a test: kadeep tests show <test>', async () => (await listTests(c, p.id)).map((t) => ({ label: t.name, value: t.key, hint: [t.lastRunStatus, t.key].filter(Boolean).join(' · ') }))))
      const t = await getTest(c, p.id, key)
      return out.result(t, () => printTest(out, t))
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}". Use: kadeep tests [list] | kadeep tests show <test>`)
    const rows = await listTests(c, p.id, { suite: values.suite, label: values.label, search: values.search })
    out.result(rows, () => {
      if (!rows.length) return out.line('No test cases match.')
      out.table(['KEY', 'LAST RUN', 'PRIORITY', 'NAME'], rows.map((t) => [t.key, out.status(t.lastRunStatus), t.priority ?? '', t.name]))
      openHint(out, 'kadeep tests show <key>')
    })
  }
}

/** @type {Command} */
const runs = {
  name: 'runs',
  summary: 'Recent test runs, or one run step by step',
  usage: ['kadeep runs [--test <key>] [--limit <n>]', 'kadeep runs show [<runId>]      # without an id, pick from the list'],
  options: { test: { type: 'string' }, limit: { type: 'string' } },
  async run({ out, client, project, positionals, values, num }) {
    const c = client('user')
    if (positionals[0] === 'show') {
      const id = positionals[1] ?? (await pickOne(out, 'Pass a run id: kadeep runs show <runId>', async () => (await listRuns(c, (await project(c)).id, { test: values.test, limit: 30 })).map(runOption(out))))
      const r = await getRun(c, id)
      return out.result(r, () => printRun(out, r))
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}". Use: kadeep runs [list] | kadeep runs show <runId>`)
    const p = await project(c)
    const rows = await listRuns(c, p.id, { test: values.test, limit: num('limit') })
    out.result(rows, () => {
      if (!rows.length) return out.line('No runs yet.')
      out.table(['', 'ID', 'STARTED', 'TOOK', 'VERDICT', 'TEST'], rows.map((r) => [out.mark(r.status), r.id, when(r.startedAt), duration(r.durationMs), r.verdict ?? r.status, r.test]))
      openHint(out, 'kadeep runs show <id>')
    })
  }
}

/** @type {Command} */
const suiteRuns = {
  name: 'suite-runs',
  summary: 'Recent suite runs, or one suite run\'s results',
  usage: ['kadeep suite-runs [--suite <key>] [--limit <n>]', 'kadeep suite-runs show [<suiteRunId>]'],
  options: { suite: { type: 'string' }, limit: { type: 'string' } },
  async run({ out, client, project, positionals, values, num }) {
    const c = client('user')
    const p = await project(c)
    if (positionals[0] === 'show') {
      const id = positionals[1] ?? (await pickOne(out, 'Pass a suite run id: kadeep suite-runs show <id>', async () => (await listSuiteRuns(c, p.id, { suite: values.suite, limit: 30 })).map((r) => ({ label: `${out.mark(r.status)} ${r.suite}`, value: r.id, hint: `${r.passed} passed · ${r.failed} failed · ${ago(r.startedAt)}` }))))
      const sr = await getSuiteRun(c, p.id, id)
      return out.result(sr, () => printSuiteRun(out, sr))
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}".`)
    const rows = await listSuiteRuns(c, p.id, { suite: values.suite, limit: num('limit') })
    out.result(rows, () => {
      if (!rows.length) return out.line('No suite runs yet.')
      out.table(['', 'ID', 'STARTED', 'PASSED', 'FAILED', 'SUITE'], rows.map((r) => [out.mark(r.status), r.id, when(r.startedAt), r.passed, r.failed, r.suite]))
      openHint(out, 'kadeep suite-runs show <id>')
    })
  }
}

/** @type {Command} */
const issues = {
  name: 'issues',
  aliases: ['defects'],
  summary: 'Defects found in a project',
  usage: ['kadeep issues [--status new|dismissed|closed]'],
  options: { status: { type: 'string' } },
  async run({ out, client, project, values }) {
    const c = client('user')
    const p = await project(c)
    const rows = await listIssues(c, p.id, { status: values.status })
    out.result(rows, () => {
      if (!rows.length) return out.line('No issues.')
      const sev = (/** @type {string} */ v) => (v === 'critical' ? out.c.red(v) : v === 'major' ? out.c.yellow(v) : out.c.muted(v))
      out.table(['ID', 'SEVERITY', 'STATUS', 'TITLE'], rows.map((i) => [i.id, sev(i.severity), i.status, i.title]))
    })
  }
}

export default [projects, use, suites, tests, runs, suiteRuns, issues]
