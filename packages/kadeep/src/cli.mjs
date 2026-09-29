// @ts-check
import { parseArgs } from 'node:util'
import { resolveProject } from './api.mjs'
import { createClient, resolveAuth } from './client.mjs'
import { DEFAULT_API, loadConfig, resolveApi, updateConfig } from './config.mjs'
import { EXIT, KadeepError, usage, VERSION } from './errors.mjs'
import { createOutput } from './output.mjs'
import { dotFill, header } from './ui/index.mjs'
import ask from './commands/ask.mjs'
import auth from './commands/auth.mjs'
import browse from './commands/browse.mjs'
import ciToken from './commands/ci-token.mjs'
import init from './commands/init.mjs'
import jobs from './commands/jobs.mjs'
import loc from './commands/loc.mjs'
import mcp from './commands/mcp.mjs'
import run from './commands/run.mjs'

/**
 * @typedef {{ type: 'string' | 'boolean', short?: string, multiple?: boolean }} OptionSpec
 * @typedef {{
 *   name: string,
 *   aliases?: string[],
 *   summary: string,
 *   usage: string[],
 *   options?: Record<string, OptionSpec>,
 *   run: (ctx: Context) => Promise<number | void>
 * }} Command
 * @typedef {{
 *   values: Record<string, any>,
 *   positionals: string[],
 *   out: import('./output.mjs').Output,
 *   env: NodeJS.ProcessEnv,
 *   config: import('./config.mjs').Config,
 *   api: string,
 *   client: (need: 'user' | 'run' | 'ci' | 'any') => import('./client.mjs').Client,
 *   project: (client: import('./client.mjs').Client) => Promise<{ id: string, name?: string, [k: string]: unknown }>,
 *   num: (name: string) => number | undefined,
 *   signal?: AbortSignal
 * }} Context
 *   `signal` is set inside the interactive session: it aborts when the user interrupts the command (Esc, Ctrl-C).
 */

/** @type {Record<string, OptionSpec>} */
const GLOBAL = {
  json: { type: 'boolean' },
  api: { type: 'string' },
  project: { type: 'string', short: 'p' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' }
}

/** @type {Command[]} */
export const COMMANDS = [...auth, ...browse, ...run, ...jobs, ...ask, ...loc, ...ciToken, ...init, ...mcp]

/** @param {string} name */
const find = (name) => COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))

/** Help groups, in the order a new user meets them. */
const GROUPS = [
  ['Account', ['login', 'logout', 'whoami']],
  ['Tests', ['projects', 'use', 'suites', 'tests', 'issues']],
  ['Runs', ['run', 'jobs', 'runs', 'suite-runs']],
  ['KaDeep agent', ['ask']],
  ['Setup and CI', ['init', 'ci-token']],
  ['Coding agents', ['mcp']],
  ['Localization', ['loc']]
]

/** @param {import('./output.mjs').Output} out */
function globalHelp(out) {
  const { c } = out
  const width = Math.max(...COMMANDS.map((cmd) => cmd.name.length))
  const grouped = GROUPS.flatMap(([title, names]) => [
    '',
    c.bold(String(title)),
    ...COMMANDS.filter((cmd) => names.includes(cmd.name)).map((cmd) => `  ${c.accent(cmd.name.padEnd(width))}  ${cmd.summary}`)
  ])
  return [
    `kadeep ${VERSION}: KaDeep Studios from the terminal, CI and coding agents.`,
    c.muted('Engineering release confidence.'),
    '',
    'usage: kadeep <command> [options]',
    `       kadeep                 ${c.muted('in a terminal: the interactive home (commands, search, the KaDeep agent)')}`,
    ...grouped,
    '',
    c.bold('Global options'),
    '  --json            one JSON document on stdout (for scripts and agents)',
    '  -p, --project     project id or name (or KADEEP_PROJECT, or `kadeep use`)',
    '  --api <url>       KaDeep API (default https://api.kadeep.ai)',
    '  --no-color        plain output',
    '  -h, --help        help for a command: kadeep <command> --help',
    '  -v, --version',
    '',
    c.bold('Environment'),
    '  KADEEP_API · KADEEP_PROJECT · KADEEP_TOKEN · KADEEP_CI_TOKEN · NO_COLOR',
    '',
    c.bold('Exit codes'),
    '  0 ok · 1 tests failed · 2 usage or sign-in · 3 unreachable · 4 not ready'
  ].join('\n')
}

/**
 * The text beside the KS mark on the home screen: version, who you are signed in as, the project (by name).
 * @param {import('./ui/style.mjs').Style} style
 * @param {{ email?: string, project?: { id?: string, name?: string }, api: string }} who
 * @param {{ session?: boolean }} [o]  inside the interactive session the hints name its slash commands
 */
export function homeText(style, who, o = {}) {
  return [
    undefined,
    undefined,
    `${style.bold('KaDeep Studios CLI')}  ${style.muted(VERSION)}`,
    style.muted('Engineering release confidence.'),
    undefined,
    who.email ? `Signed in as ${style.accent(who.email)}` : `${style.warn('Not signed in')}  ${style.muted('·')}  ${o.session ? '/login' : 'kadeep login'}`,
    who.project?.id ? `Project  ${style.bold(who.project.name ?? who.project.id)}` : style.muted(o.session ? 'No project yet · /project' : 'No default project · kadeep use'),
    who.api !== DEFAULT_API ? style.muted(`API  ${who.api}`) : undefined
  ]
}

/**
 * Remember the default project's name next to its id, so the home screen can show it (0.1 stored only the id).
 * Never fails: a read-only config just means the name is looked up again next time.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} api
 * @param {{ id: string, name?: string }} project
 */
export function rememberProjectName(env, api, project) {
  if (!project?.name) return
  const d = loadConfig(env).defaults?.[api]
  if (!d?.project || d.project !== project.id || d.projectName === project.name) return
  try {
    updateConfig((cfg) => {
      if (cfg.defaults?.[api]?.project === project.id) cfg.defaults[api].projectName = project.name
    }, env)
  } catch {
    /* read-only config */
  }
}

/**
 * The default project, with its name: from the config, or (when only the id is known and you are signed in) looked
 * up on KaDeep within 3 seconds and remembered.
 * @param {NodeJS.ProcessEnv} env
 * @param {string} api
 * @returns {Promise<{ id?: string, name?: string }>}
 */
export async function defaultProject(env, api) {
  const config = loadConfig(env)
  const d = config.defaults?.[api]
  if (!d?.project || d.projectName) return { id: d?.project, name: d?.projectName }
  try {
    const c = createClient({ api, auth: resolveAuth('user', { api, env, config }), env })
    /** @type {Array<{ id: string, name: string }>} */
    const all = await c.get('/api/projects', { timeoutMs: 3000 })
    const hit = all.find((p) => p.id === d.project)
    if (hit) rememberProjectName(env, api, hit)
    return { id: d.project, name: hit?.name }
  } catch {
    return { id: d.project }
  }
}

/**
 * `kadeep` on its own in a rich terminal that cannot take keyboard input (stdin is not a terminal): the KS mark with
 * who and where you are, and what to run next. The first time, the mark's dots light up one by one. With a keyboard,
 * `kadeep` opens the interactive home instead (session/index.mjs).
 * @param {import('./output.mjs').Output} out
 * @param {NodeJS.ProcessEnv} env
 */
async function welcome(out, env) {
  const { style, g } = out.ui
  const config = loadConfig(env)
  const api = resolveApi({ env, config })
  const session = config.sessions?.[api]
  const text = homeText(style, { email: session?.user?.email, project: session ? await defaultProject(env, api) : { id: config.defaults?.[api]?.project, name: config.defaults?.[api]?.projectName }, api })
  await showHeader(out, env, text)
  const next = session
    ? [['kadeep run --suite smoke', 'run a suite and wait for the verdict'], ['kadeep ask "…"', 'ask the KaDeep agent'], ['kadeep init', 'set up this repo: releasegate policy, CI, agents'], ['kadeep --help', 'every command']]
    : [['kadeep login', 'sign in with your KaDeep Studios account'], ['kadeep --help', 'every command']]
  out.lines(['', style.muted(`${g.small} ${g.small} ${g.small}`), ...next.map(([cmd, what]) => `  ${style.accent(String(cmd).padEnd(26))}${style.muted(String(what))}`), ''])
}

/**
 * The logo header; the first time, with the dot-fill animation (remembered in the config).
 * @param {import('./output.mjs').Output} out
 * @param {NodeJS.ProcessEnv} env
 * @param {Array<string | undefined>} text
 */
export async function showHeader(out, env, text) {
  const { term, style, g } = out.ui
  if (!loadConfig(env).ui?.welcomeSeen && style.level > 0 && !env.KADEEP_NO_ANIMATION) {
    await dotFill(term, g, style, text)
    try {
      updateConfig((cfg) => {
        cfg.ui = { ...cfg.ui, welcomeSeen: true }
      }, env)
    } catch {
      /* read-only config: animate again next time */
    }
  } else out.lines(header(term, g, style, text))
}

/** @param {Command} cmd */
function commandHelp(cmd) {
  return [`${cmd.summary}`, '', 'usage:', ...cmd.usage.map((u) => `  ${u}`), '', 'Global options (--json, --project, --api) work here too.'].join('\n')
}

/**
 * Run the CLI. Returns the exit code instead of exiting, so stdout is flushed before the process ends.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, { env = process.env } = {}) {
  const pre = parseArgs({ args: argv, options: GLOBAL, strict: false, allowPositionals: true })
  const wantsJson = Boolean(pre.values.json)
  const out = createOutput({ json: wantsJson, noColor: Boolean(pre.values['no-color']), env })
  const name = pre.positionals[0]
  try {
    if (pre.values.version && !name) {
      out.result({ version: VERSION }, () => out.line(VERSION))
      return EXIT.OK
    }
    if (!name && !pre.values.help && out.rich) {
      if (out.ui.term.interactive) {
        const { startSession } = await import('./session/index.mjs')
        return await startSession({ env, noColor: Boolean(pre.values['no-color']), api: typeof pre.values.api === 'string' ? pre.values.api : undefined, project: typeof pre.values.project === 'string' ? pre.values.project : undefined })
      }
      await welcome(out, env)
      return EXIT.OK
    }
    if (!name || name === 'help') {
      const target = name === 'help' && pre.positionals[1] ? find(pre.positionals[1]) : undefined
      out.result({ version: VERSION, commands: COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases ?? [], summary: c.summary, usage: c.usage })) }, () => out.line(target ? commandHelp(target) : globalHelp(out)))
      return EXIT.OK
    }
  } catch (err) {
    return fail(out, err, env)
  }
  return runCommand(argv, { env })
}

/**
 * Parse and run one command. `kadeep <command>` comes here, and so does every command typed in the interactive
 * session, with the session's keyboard hub and an AbortSignal the user trips with Esc or Ctrl-C.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv, session?: import('./ui/term.mjs').Session, streams?: { stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream } }} [opts]
 * @returns {Promise<number>}
 */
export async function runCommand(argv, { env = process.env, session, streams = {} } = {}) {
  const pre = parseArgs({ args: argv, options: GLOBAL, strict: false, allowPositionals: true })
  let out = createOutput({ json: Boolean(pre.values.json), noColor: Boolean(pre.values['no-color']), env, session, ...streams })
  const name = pre.positionals[0]
  try {
    const cmd = find(name ?? '')
    if (!cmd) throw usage(`Unknown command "${name}". Run \`kadeep --help\` for the list.`)
    const rest = [...argv]
    rest.splice(rest.indexOf(/** @type {string} */ (name)), 1)
    /** @type {{ values: Record<string, any>, positionals: string[] }} */
    let parsed
    try {
      parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...cmd.options }, strict: true, allowPositionals: true })
    } catch (err) {
      throw usage(`${/** @type {Error} */ (err).message.replace(/\. To specify a positional argument.*$/s, '')}\nRun \`kadeep ${cmd.name} --help\`.`)
    }
    const values = parsed.values
    out = createOutput({ json: Boolean(values.json), noColor: Boolean(values['no-color']), accent: cmd.name === 'loc' ? 'loc' : 'testing', env, session, ...streams })
    if (values.help) {
      out.result({ name: cmd.name, summary: cmd.summary, usage: cmd.usage, options: Object.keys(cmd.options ?? {}) }, () => out.line(commandHelp(cmd)))
      return EXIT.OK
    }
    const config = loadConfig(env)
    const api = resolveApi({ flag: values.api, env, config })
    /** @type {Context} */
    const ctx = {
      values,
      positionals: parsed.positionals,
      out,
      env,
      config,
      api,
      client: (need) => createClient({ api, auth: resolveAuth(need, { api, env, config }), env }),
      project: async (client) => {
        const p = await resolveProject(client, { ref: values.project, env, config })
        rememberProjectName(env, api, p)
        return p
      },
      num: (key) => {
        const v = values[key]
        if (v === undefined) return undefined
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw usage(`--${key} must be a number ≥ 0`)
        return n
      },
      ...(session?.signal ? { signal: session.signal } : {})
    }
    return (await cmd.run(ctx)) ?? EXIT.OK
  } catch (err) {
    if (session?.signal?.aborted) return 130
    return fail(out, err, env)
  }
}

/**
 * Report an error the way every command does and return its exit code.
 * @param {import('./output.mjs').Output} out
 * @param {unknown} err
 * @param {NodeJS.ProcessEnv} env
 */
function fail(out, err, env) {
  if (err instanceof KadeepError) {
    out.error(err)
    return err.exitCode
  }
  const e = /** @type {Error} */ (err)
  out.error({ message: e?.message ?? String(err), code: 'internal' })
  if (env.KADEEP_DEBUG) process.stderr.write(`${e?.stack ?? ''}\n`)
  return EXIT.FAILED
}
