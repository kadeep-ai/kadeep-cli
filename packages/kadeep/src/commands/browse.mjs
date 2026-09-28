// @ts-check
import { resolveProject } from '../api.mjs'
import { updateConfig } from '../config.mjs'
import { usage } from '../errors.mjs'
import { duration } from '../output.mjs'
import { getRun, getSuiteRun, getTest, listIssues, listProjects, listRuns, listSuiteRuns, listSuites, listTests } from '../ops/browse.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @param {string | undefined} iso */
const when = (iso) => (iso ? iso.replace('T', ' ').slice(0, 16) : '')

/** @type {Command} */
const projects = {
  name: 'projects',
  summary: 'List your projects (* = default)',
  usage: ['kadeep projects'],
  async run({ out, client, config, api, env }) {
    const rows = await listProjects(client('user'), env.KADEEP_PROJECT || config.defaults?.[api]?.project)
    out.result(rows, () => {
      if (!rows.length) return out.line('No projects yet. Create one in the KaDeep app.')
      out.table(['', 'ID', 'NAME', 'KIND', 'URL'], rows.map((p) => [p.default ? '*' : '', p.id, p.name, p.kind, p.baseUrl ?? '']))
    })
  }
}

/** @type {Command} */
const use = {
  name: 'use',
  summary: 'Set the default project for this API',
  usage: ['kadeep use <project>          # id or name'],
  async run({ out, client, positionals, api, env, values }) {
    const ref = positionals[0] ?? values.project
    if (!ref) throw usage('Pass a project id or name: kadeep use <project>')
    const p = await resolveProject(client('user'), { ref, env: { ...env, KADEEP_PROJECT: undefined } })
    updateConfig((cfg) => {
      cfg.defaults ??= {}
      cfg.defaults[api] = { ...cfg.defaults[api], project: p.id }
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
      out.table(['KEY', 'TESTS', 'LAST RUN', 'NAME'], rows.map((s) => [s.key, s.tests, s.lastRunStatus ?? '', s.name]))
    })
  }
}

/** @type {Command} */
const tests = {
  name: 'tests',
  aliases: ['flows', 'test-cases'],
  summary: 'List test cases, or show one',
  usage: ['kadeep tests [--suite <key>] [--label <label>] [--search <text>]', 'kadeep tests show <test>        # key, id or name'],
  options: { suite: { type: 'string' }, label: { type: 'string' }, search: { type: 'string' } },
  async run({ out, client, project, positionals, values }) {
    const c = client('user')
    const p = await project(c)
    if (positionals[0] === 'show') {
      const key = positionals[1]
      if (!key) throw usage('Pass a test: kadeep tests show <test>')
      const t = await getTest(c, p.id, key)
      return out.result(t, () => {
        out.line(`${out.c.bold(t.name)}  ${out.c.dim(t.key)}${t.priority ? `  ${t.priority}` : ''}${t.labels.length ? `  [${t.labels.join(', ')}]` : ''}`)
        if (t.description) out.line(t.description)
        out.line()
        out.line(t.instructions ?? '')
        if (t.steps?.length) {
          out.line()
          t.steps.forEach((/** @type {string} */ s, /** @type {number} */ i) => out.line(`  ${i + 1}. ${s}`))
        }
        if (t.expected) out.line(`\nExpected: ${t.expected}`)
        out.line(out.c.dim(`\nlast run: ${t.lastRunStatus ?? 'never'}${t.lastRunId ? ` (${t.lastRunId})` : ''}`))
      })
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}". Use: kadeep tests [list] | kadeep tests show <test>`)
    const rows = await listTests(c, p.id, { suite: values.suite, label: values.label, search: values.search })
    out.result(rows, () => {
      if (!rows.length) return out.line('No test cases match.')
      out.table(['KEY', 'LAST RUN', 'PRIORITY', 'NAME'], rows.map((t) => [t.key, t.lastRunStatus ?? '', t.priority ?? '', t.name]))
    })
  }
}

/** @type {Command} */
const runs = {
  name: 'runs',
  summary: 'Recent test runs, or one run step by step',
  usage: ['kadeep runs [--test <key>] [--limit <n>]', 'kadeep runs show <runId>'],
  options: { test: { type: 'string' }, limit: { type: 'string' } },
  async run({ out, client, project, positionals, values, num }) {
    const c = client('user')
    if (positionals[0] === 'show') {
      const id = positionals[1]
      if (!id) throw usage('Pass a run id: kadeep runs show <runId>')
      const r = await getRun(c, id)
      return out.result(r, () => {
        out.line(`${out.mark(r.status)} ${out.c.bold(r.test)}  ${r.status}${r.verdict && r.verdict !== 'PASS' ? ` [${r.verdict}]` : ''}  ${duration(r.durationMs)}  ${out.c.dim(r.id)}`)
        if (r.summary) out.line(r.summary)
        if (r.error) out.line(out.c.red(r.error))
        if (r.verdictReason) out.line(out.c.dim(r.verdictReason))
        if (r.steps.length) out.line()
        for (const s of r.steps) out.line(`  ${String(s.n).padStart(3)}. ${s.ok ? out.c.green('ok  ') : out.c.red('FAIL')} ${s.tool}${s.target ? ` ${s.target}` : ''}${s.result ? out.c.dim(` · ${String(s.result).slice(0, 160)}`) : ''}`)
        if (r.report) out.line(out.c.dim(`\nreport: ${r.report}`))
      })
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}". Use: kadeep runs [list] | kadeep runs show <runId>`)
    const p = await project(c)
    const rows = await listRuns(c, p.id, { test: values.test, limit: num('limit') })
    out.result(rows, () => {
      if (!rows.length) return out.line('No runs yet.')
      out.table(['', 'ID', 'STARTED', 'TOOK', 'VERDICT', 'TEST'], rows.map((r) => [out.mark(r.status), r.id, when(r.startedAt), duration(r.durationMs), r.verdict ?? r.status, r.test]))
    })
  }
}

/** @type {Command} */
const suiteRuns = {
  name: 'suite-runs',
  summary: 'Recent suite runs, or one suite run\'s results',
  usage: ['kadeep suite-runs [--suite <key>] [--limit <n>]', 'kadeep suite-runs show <suiteRunId>'],
  options: { suite: { type: 'string' }, limit: { type: 'string' } },
  async run({ out, client, project, positionals, values, num }) {
    const c = client('user')
    const p = await project(c)
    if (positionals[0] === 'show') {
      const id = positionals[1]
      if (!id) throw usage('Pass a suite run id: kadeep suite-runs show <id>')
      const sr = await getSuiteRun(c, p.id, id)
      return out.result(sr, () => {
        out.line(`${out.mark(sr.status)} ${out.c.bold(sr.suite)}  ${sr.passed} passed, ${sr.failed} failed  ${out.c.dim(sr.id)}`)
        for (const r of sr.runs ?? []) out.line(`  ${out.mark(r.status)} ${r.name}${r.verdict && r.verdict !== 'PASS' ? ` [${r.verdict}]` : ''}${r.error ? out.c.dim(` · ${r.error}`) : ''}  ${out.c.dim(r.id)}`)
      })
    }
    if (positionals[0] && positionals[0] !== 'list') throw usage(`Unknown subcommand "${positionals[0]}".`)
    const rows = await listSuiteRuns(c, p.id, { suite: values.suite, limit: num('limit') })
    out.result(rows, () => {
      if (!rows.length) return out.line('No suite runs yet.')
      out.table(['', 'ID', 'STARTED', 'PASSED', 'FAILED', 'SUITE'], rows.map((r) => [out.mark(r.status), r.id, when(r.startedAt), r.passed, r.failed, r.suite]))
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
      out.table(['ID', 'SEVERITY', 'STATUS', 'TITLE'], rows.map((i) => [i.id, i.severity, i.status, i.title]))
    })
  }
}

export default [projects, use, suites, tests, runs, suiteRuns, issues]
