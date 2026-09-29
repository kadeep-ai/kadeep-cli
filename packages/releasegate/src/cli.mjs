// @ts-check
import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { ciContext, createClient, duration, EXIT, loadConfig, resolveApi, resolveAuth, ui as kui, USER_AGENT } from 'kadeep'
import { errorReport, exitCode, runGate } from './gate.mjs'
import { findPolicy, loadPolicy, PolicyError } from './policy.mjs'
import { annotations, commitLine, githubSummary, verdictLine, writeReports } from './report.mjs'
import { VERSION } from './version.mjs'
import { gateView } from './view.mjs'

/** @type {Record<string, { type: 'string' | 'boolean', short?: string }>} */
const OPTIONS = {
  policy: { type: 'string' },
  mode: { type: 'string' },
  shadow: { type: 'boolean' },
  enforce: { type: 'boolean' },
  'report-dir': { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  api: { type: 'string' },
  project: { type: 'string', short: 'p' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
}

const HELP = `KaDeep Release Gate ${VERSION}: go / no-go for a release. Engineering release confidence.

usage: releasegate [options]

Reads the policy (releasegate.yml), runs the required KaDeep checks for the current commit, writes a report and
exits pass / fail.

options:
  --policy <file>       policy file (default: releasegate.yml, .yaml or .json in the current directory)
  --mode enforce|shadow override the policy's mode; --shadow and --enforce are short forms
  --report-dir <dir>    where report.json, report.md and junit.xml go (default: the policy's, else .releasegate)
  --dry-run             validate the policy and settings, list the checks, run nothing
  --json                print the report as JSON on stdout
  -p, --project <id>    override the policy's project
  --api <url>           KaDeep API (default: KADEEP_API, else https://api.kadeep.ai)

environment:
  KADEEP_CI_TOKEN       the project's CI token (required in CI; locally a \`kadeep login\` works for test checks)
  RELEASEGATE_MODE      enforce or shadow, overrides the policy
  KADEEP_API, KADEEP_PROJECT

modes:
  enforce   exit 0 GO · 1 NO-GO · 2 bad policy, token or setup · 3 KaDeep unreachable
  shadow    runs everything and reports the verdict, always exits 0 (for first-time setup)`

/** @param {unknown} v @returns {'enforce' | 'shadow' | undefined} */
const asMode = (v) => (v === 'enforce' || v === 'shadow' ? v : undefined)

/**
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream }} [io]
 * @returns {Promise<number>}
 */
export async function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  // Known before anything can fail: in shadow mode nothing here may fail the build.
  const shadowHinted = argv.includes('--shadow') || argv.some((a, i) => (a === '--mode' && argv[i + 1] === 'shadow') || a === '--mode=shadow') || env.RELEASEGATE_MODE === 'shadow'
  /** @type {Record<string, any>} */
  let values
  try {
    values = parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false }).values
  } catch (err) {
    stderr.write(`releasegate: ${/** @type {Error} */ (err).message.split('. ')[0]}\nRun \`releasegate --help\`.\n`)
    return shadowHinted ? EXIT.OK : EXIT.USAGE
  }
  if (values.help) {
    stdout.write(`${HELP}\n`)
    return EXIT.OK
  }
  if (values.version) {
    stdout.write(`${VERSION}\n`)
    return EXIT.OK
  }
  const json = Boolean(values.json)
  // kadeep's terminal UI decides once: rich on a laptop (live checklist, dots, the verdict in large dots), plain in CI
  // and pipes (exactly the lines 0.1 printed, which CI logs and annotations rely on), or JSON.
  const u = kui.createUi({ json, noColor: Boolean(values['no-color']), env, stdout: /** @type {any} */ (stdout), stderr: /** @type {any} */ (stderr) })
  const { style } = u
  const green = style.ok
  const red = style.fail
  const yellow = style.warn
  const dim = style.dim
  const bold = style.bold
  /** @param {string} [line] */
  const say = (line = '') => {
    if (!json) stdout.write(`${line}\n`)
  }
  /** @param {string} line */
  const note = (line) => stderr.write(`${line}\n`)

  const flagMode = values.shadow ? 'shadow' : values.enforce ? 'enforce' : values.mode
  if (flagMode !== undefined && !asMode(flagMode)) {
    stderr.write('releasegate: --mode must be enforce or shadow\n')
    return shadowHinted ? EXIT.OK : EXIT.USAGE
  }
  const config = loadConfig(env)
  const api = resolveApi({ flag: values.api, env, config })
  const commit = ciContext(env, { cwd })
  say(`${bold('KaDeep Release Gate')} ${VERSION} · Engineering release confidence.`)

  /**
   * @param {import('./gate.mjs').Report} report
   * @param {{ dir: string, junit: boolean, markdown: boolean }} reportOpts
   */
  const finish = (report, reportOpts) => {
    /** @type {Record<string, string>} */
    let files = {}
    try {
      files = writeReports(report, { ...reportOpts, dir: values['report-dir'] ?? reportOpts.dir }, cwd)
    } catch (err) {
      note(`${yellow('!')} Could not write the report: ${/** @type {Error} */ (err).message}`)
    }
    githubSummary(report, env)
    if (json) stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    else if (u.rich) view.finish(report, files.markdown ?? files.json ? relative(cwd, files.markdown ?? files.json) : undefined)
    else {
      if (env.GITHUB_ACTIONS === 'true') for (const a of annotations(report)) say(a)
      say()
      const required = report.checks.filter((c) => c.required)
      const bad = required.filter((c) => c.status !== 'passed').length
      const tally = report.checks.length ? ` · ${required.length - bad}/${required.length} required checks passed` : ''
      const colour = report.verdict === 'GO' ? green : report.mode === 'shadow' ? yellow : red
      say(`${colour(bold(verdictLine(report)))}${tally} · ${duration(report.durationMs)}`)
      if (report.error) say(report.error)
      if (files.markdown ?? files.json) say(dim(`report: ${relative(cwd, files.markdown ?? files.json)}`))
    }
    return exitCode(report)
  }

  let view = gateView(u, [], stdout)

  /** @param {'enforce' | 'shadow'} mode @param {string} error @param {{ project?: string, policy?: string, errorExit?: number }} [extra] */
  const setupError = (mode, error, extra = {}) => finish(errorReport({ mode, api, commit, error, ...extra }), { dir: '.releasegate', junit: false, markdown: true })

  /** @type {import('./policy.mjs').Policy} */
  let policy
  try {
    policy = loadPolicy(findPolicy(cwd, values.policy))
  } catch (err) {
    if (!(err instanceof PolicyError)) throw err
    return setupError(asMode(flagMode) ?? asMode(env.RELEASEGATE_MODE) ?? err.mode ?? 'enforce', err.message)
  }
  const mode = asMode(flagMode) ?? asMode(env.RELEASEGATE_MODE) ?? policy.mode
  const project = values.project ?? policy.project ?? env.KADEEP_PROJECT
  const shownPolicy = relative(cwd, policy.file) || policy.file
  say(dim([project ? `project ${project}` : '', commitLine({ commit }), `mode ${mode}`, api].filter(Boolean).join(' · ')))
  if (!project) return setupError(mode, `No project: set project: in ${shownPolicy} (or KADEEP_PROJECT, or --project).`, { policy: policy.file })

  const ciToken = env.KADEEP_CI_TOKEN || env.TESTSTUDIOS_CI_TOKEN
  /** @type {import('kadeep').Auth} */
  let auth
  if (ciToken) auth = { kind: 'ci', token: ciToken }
  else {
    try {
      auth = resolveAuth('user', { api, env, config })
    } catch {
      const how = commit.provider === 'github' ? 'Add the repository secret KADEEP_CI_TOKEN and pass it to this step:  env: { KADEEP_CI_TOKEN: ${{ secrets.KADEEP_CI_TOKEN }} }' : "Set it to the project's CI token (`npx kadeep ci-token create`)."
      return setupError(mode, `KADEEP_CI_TOKEN is not set. ${how}`, { project, policy: policy.file })
    }
  }

  if (values['dry-run']) {
    const plan = { ok: true, dryRun: true, mode, project, api, policy: policy.file, auth: auth.kind, commit, checks: policy.checks }
    if (json) stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    else {
      say(`${shownPolicy} is valid. ${policy.checks.length} check${policy.checks.length === 1 ? '' : 's'} would run:`)
      for (const c of policy.checks) say(`  - ${c.name} (${c.type === 'suite' ? `suite ${c.suite}` : c.type === 'tests' ? `tests ${c.tests?.join(', ')}` : `localization${c.localization?.locales ? ` ${c.localization.locales.join(', ')}` : ''}`})${c.required ? '' : ' · advisory'}`)
    }
    return EXIT.OK
  }

  const client = createClient({ api, auth, env, userAgent: `releasegate/${VERSION} ${USER_AGENT}` })
  if (u.rich) {
    view = gateView(u, policy.checks, stdout)
    view.start()
  }
  const report = await runGate({
    policy,
    mode,
    project,
    api,
    client,
    commit,
    onEvent: (e) => {
      if (json) return
      if (u.rich) return view.event(e)
      if (e.type === 'start') say(`${dim('▸')} ${e.check.name}${e.check.required ? '' : dim(' (advisory)')}`)
      else if (e.type === 'progress') note(dim(`    ${e.message}`))
      else {
        const r = e.result
        const mark = r.status === 'passed' ? green('✓') : r.status === 'failed' ? red('✗') : yellow('!')
        say(`${mark} ${r.name}: ${r.summary} ${dim(`(${duration(r.durationMs)})`)}`)
        for (const run of r.runs ?? []) if (run.status !== 'passed') say(`    ${red('✗')} ${run.name}${run.verdict && run.verdict !== 'PASS' ? ` [${run.verdict}]` : ''}${run.error ? dim(` · ${run.error}`) : ''}`)
      }
    }
  })
  return finish(report, policy.report)
}
