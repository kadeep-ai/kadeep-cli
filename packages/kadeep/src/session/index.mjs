// @ts-check
import { resolveProject, routes } from '../api.mjs'
import { COMMANDS, defaultProject, homeText, rememberProjectName, runCommand, showHeader } from '../cli.mjs'
import { createClient, resolveAuth } from '../client.mjs'
import { clientId, loadConfig, resolveApi } from '../config.mjs'
import { EXIT, KadeepError } from '../errors.mjs'
import { createOutput } from '../output.mjs'
import { createChat, llmProblem, MODE_HELP, MODES } from '../agent/chat.mjs'
import { converse } from '../agent/converse.mjs'
import { BACK, createKeys, createPrompts, truncate, withSpinner, wrap } from '../ui/index.mjs'
import { ago } from '../views/details.mjs'
import { createScreens, until } from './screens.mjs'
import { createIndex } from './search.mjs'

/**
 * `kadeep` on its own, in a terminal: the interactive home, in the style of Claude Code. One prompt drives
 * everything:
 *
 *   plain text    goes to the KaDeep agent (the same agent as KaDeep Studios' chat), streamed back
 *   /command      the palette: runs, suites, tests, issues, run, project, chats… (any CLI command works too)
 *   typing        searches test cases, suites and runs as you type; ↓ and enter open one
 *   shift+tab     agent mode → plan mode → ask mode
 *   esc / ctrl-c  interrupt what is running (the prompt: clear the line; twice on an empty line: exit)
 *
 * Every list is a picker and every record opens with what you can do next, so no id is ever copied by hand.
 *
 * The session owns the keyboard (one input hub, stdin in raw mode for its whole life) and gives each command an
 * AbortSignal; interrupting a command clears its live view and silences it, and control comes back to the prompt.
 *
 * @typedef {import('../ui/term.mjs').Session} Session
 */

/** The palette, in the order a new user needs it. */
const PALETTE = [
  { name: 'runs', summary: 'recent runs · pick one to open it', usage: '/runs  (pick one)  ·  /runs show <id>' },
  { name: 'run', summary: 'run a suite or a test case and watch it', usage: '/run  ·  /run --suite <key> [--viewport mobile]  ·  /run --test <key>' },
  { name: 'suites', summary: 'suites · run one, see its tests and results' },
  { name: 'tests', summary: 'test cases · open one, run it' },
  { name: 'suite-runs', summary: 'recent suite runs and their results' },
  { name: 'issues', summary: 'defects KaDeep found' },
  { name: 'search', summary: 'find test cases, suites and runs', usage: '/search <text>' },
  { name: 'project', summary: 'switch project' },
  { name: 'mode', summary: 'agent · plan · ask (or shift+tab)', usage: '/mode agent|plan|ask' },
  { name: 'chats', summary: 'continue an earlier conversation with the agent' },
  { name: 'new', summary: 'start a new conversation with the agent' },
  { name: 'open', summary: 'what the agent ran or made in this session' },
  { name: 'init', summary: 'set up this repo: releasegate, CI, coding agents' },
  { name: 'jobs', summary: 'follow a queued job', usage: '/jobs show <jobId> --wait' },
  { name: 'login', summary: 'sign in' },
  { name: 'logout', summary: 'sign out' },
  { name: 'whoami', summary: 'who and where you are' },
  { name: 'mcp', summary: 'add KaDeep to Cursor or Claude Code' },
  { name: 'help', summary: 'commands and keys' },
  { name: 'clear', summary: 'clear the screen' },
  { name: 'exit', summary: 'leave kadeep' }
]

const INTERRUPTED = Symbol('interrupted')

/**
 * Split a command line into arguments: spaces separate, quotes group, backslash escapes.
 * @param {string} line
 */
export function splitArgs(line) {
  /** @type {string[]} */
  const args = []
  let cur = ''
  let quote = ''
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = ''
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < line.length) {
      cur += line[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (cur || has) args.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (cur || has) args.push(cur)
  return args
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, noColor?: boolean, api?: string, project?: string, stdin?: NodeJS.ReadStream, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream }} opts
 * @returns {Promise<number>}
 */
export async function startSession(opts = {}) {
  const env = opts.env ?? process.env
  const streams = { stdin: opts.stdin ?? process.stdin, stdout: opts.stdout ?? process.stdout, stderr: opts.stderr ?? process.stderr }
  const keys = createKeys(streams.stdin)
  /** @type {Session} */
  const base = { keys, lives: new Set() }
  /** Output for the session itself (never silenced), and for one interruptible interaction. @param {Session} [session] */
  const outFor = (session = base) => createOutput({ env, noColor: opts.noColor, session, ...streams })
  const out = outFor()
  const { style, g, term } = out.ui
  const prompts = createPrompts(out.ui)
  const releaseBase = keys.push(() => {})
  const onResize = () => {
    term.columns = Math.max(20, streams.stdout.columns || term.columns)
  }
  streams.stdout.on?.('resize', onResize)

  // ---- who and where
  const api = resolveApi({ flag: opts.api, env, config: loadConfig(env) })
  /** @type {{ email?: string, project: { id: string, name?: string }, mode: import('../agent/chat.mjs').AgentMode, meter?: any, llmOk: boolean }} */
  const state = { project: { id: '' }, mode: 'agent', llmOk: false }
  /** @type {import('../client.mjs').Client | undefined} */
  let cachedClient
  const signedIn = () => Boolean(env.KADEEP_TOKEN || loadConfig(env).sessions?.[api]?.accessToken)
  const client = () => (cachedClient ??= createClient({ api, auth: resolveAuth('user', { api, env, config: loadConfig(env) }), env }))
  /** @type {import('../agent/chat.mjs').Chat | undefined} */
  let chat
  /** What the agent ran or made this session, for /open. @type {Map<string, { kind: string, label: string, hint?: string, value: any }>} */
  const touched = new Map()
  /** @type {string[]} */
  const history = []
  const index = createIndex(out, client, () => state.project.id || undefined)

  async function reload() {
    cachedClient = undefined
    chat = undefined
    state.llmOk = false
    state.meter = undefined
    const config = loadConfig(env)
    state.email = config.sessions?.[api]?.user?.email
    if (!signedIn()) {
      state.project = { id: '' }
      return
    }
    if (opts.project || env.KADEEP_PROJECT) {
      try {
        const p = await resolveProject(client(), { ref: opts.project, env, config })
        state.project = { id: p.id, name: p.name }
      } catch (err) {
        out.warn(/** @type {Error} */ (err).message)
        state.project = { id: '' }
      }
    } else {
      const d = await defaultProject(env, api)
      state.project = { id: d.id ?? '', name: d.name }
    }
    if (state.project.id) index.refresh()
  }

  /**
   * Run something the user can interrupt: Esc or Ctrl-C aborts its signal, clears live views and returns here.
   * @template T
   * @param {(session: Session, signal: AbortSignal) => Promise<T>} fn
   * @returns {Promise<T | typeof INTERRUPTED>}
   */
  async function guard(fn) {
    const ac = new AbortController()
    const off = keys.push((k) => {
      if (k === 'escape' || k === 'ctrl-c') ac.abort()
    })
    try {
      return await fn({ keys, lives: base.lives, signal: ac.signal }, ac.signal)
    } catch (err) {
      if (ac.signal.aborted || (err instanceof KadeepError && err.code === 'cancelled')) return INTERRUPTED
      throw err
    } finally {
      off()
      for (const l of [...base.lives]) l.stop({ keep: false })
    }
  }

  /** A command from the CLI, run inside the session. @param {string[]} argv */
  async function cli(argv) {
    const r = await guard((session, signal) => until(signal, runCommand(argv, { env, session, streams })))
    if (r === INTERRUPTED) out.line(style.muted('  Interrupted. Anything already started on KaDeep (a run, a job) keeps going.'))
    return r
  }

  /**
   * Talk to the agent (plain text at the prompt, or "Ask the agent…" on a screen).
   * @param {string} text
   * @param {{ echo?: boolean }} [o]
   */
  async function talk(text, o = {}) {
    if (!signedIn()) return void out.line(style.warn(`  Sign in first: /login`))
    if (!state.project.id) return void out.line(style.warn(`  Pick a project first: /project`))
    if (!state.llmOk) {
      const problem = llmProblem(await withSpinner(out.ui, 'Checking the agent', () => routes.llm(client())).catch(() => null))
      if (problem) return void out.line(style.warn(`  ${g.warn} ${problem}`))
      state.llmOk = true
    }
    if (o.echo) out.lines(['', ...wrap(text, term.columns - 1, { first: `${style.muted(g.pointer)} `, indent: '  ' })])
    chat ??= createChat(client(), { project: state.project.id, clientId: clientId(env), mode: state.mode })
    chat.mode = state.mode
    const turns = await guard((_session, signal) => converse(out, chat ?? createChat(client(), { project: state.project.id, clientId: clientId(env) }), text, { signal, interruptHint: 'esc to interrupt' }))
    if (turns === INTERRUPTED) return
    state.mode = chat.mode
    let ran = false
    for (const t of turns) {
      state.meter = t.meter ?? state.meter
      for (const r of t.runs) {
        ran = true
        touched.set(`run:${r.id}`, { kind: 'run', label: `${out.mark(r.status)} ${r.flowName ?? 'Run'}`, hint: r.verdict ?? r.status, value: { kind: 'run', id: r.id } })
      }
      for (const i of t.issues) touched.set(`issue:${i.id}`, { kind: 'issue', label: String(i.title), hint: i.severity, value: { kind: 'issue', id: i.id, item: { id: i.id, title: i.title, severity: i.severity, status: i.status, runId: i.runId, testId: i.flowId, type: i.type } } })
      for (const f of t.flows) {
        ran = true
        touched.set(`test:${f.id}`, { kind: 'test', label: String(f.name), hint: f.key, value: { kind: 'test', id: f.id, key: f.key ?? f.id } })
      }
    }
    if (ran) index.refresh()
  }

  /** Open something from a screen factory, as one interruptible interaction. @param {(s: ReturnType<typeof createScreens>) => Promise<unknown>} fn */
  async function screen(fn) {
    if (!signedIn()) return void out.line(style.warn('  Sign in first: /login'))
    if (!state.project.id) return void out.line(style.warn('  Pick a project first: /project'))
    const r = await guard((session, signal) => fn(createScreens({ out: outFor(session), client, project: () => state.project, api, talk: (t) => talk(t, { echo: true }), ran: () => index.refresh() }, signal)))
    if (r === INTERRUPTED) out.line(style.muted('  Interrupted. Anything already started on KaDeep (a run, a job) keeps going.'))
  }

  function help() {
    const w = Math.max(...PALETTE.map((c) => c.name.length)) + 2
    out.lines([
      '',
      style.bold('Talk to the KaDeep agent'),
      ...wrap(`Type anything and press enter. You are in ${state.mode} mode: it ${MODE_HELP[state.mode]}.`, term.columns - 1, { indent: '  ' }),
      '',
      style.bold('Commands'),
      ...PALETTE.map((c) => `  ${style.accent(`/${c.name}`.padEnd(w + 1))} ${style.muted(c.summary)}`),
      `  ${style.muted('Every kadeep command works too: /runs show <id>, /run --suite smoke, /ci-token create…')}`,
      '',
      style.bold('Keys'),
      `  ${style.accent('/'.padEnd(12))}${style.muted('the command palette')}`,
      `  ${style.accent('↓ enter'.padEnd(12))}${style.muted('open a search match while typing')}`,
      `  ${style.accent('shift+tab'.padEnd(12))}${style.muted('agent → plan → ask mode')}`,
      `  ${style.accent('↑'.padEnd(12))}${style.muted('what you typed before')}`,
      `  ${style.accent('esc'.padEnd(12))}${style.muted('interrupt · back one screen')}`,
      `  ${style.accent('ctrl-c ×2'.padEnd(12))}${style.muted('exit')}`,
      ''
    ])
  }

  function mcpHelp() {
    out.lines([
      '',
      `${style.accent(g.dot)} ${style.bold('KaDeep in your coding agent')}`,
      `  ${style.muted('Cursor and Claude Code talk to KaDeep through its MCP server, started by the agent itself:')}`,
      `  ${style.accent('claude mcp add kadeep -- npx -y kadeep mcp')}`,
      `  ${style.muted('or run /init in your repo: it writes .mcp.json and .cursor/mcp.json for this project.')}`,
      ''
    ])
  }

  async function chats() {
    if (!signedIn() || !state.project.id) return void out.line(style.warn('  Sign in and pick a project first.'))
    const me = loadConfig(env).sessions?.[api]?.user?.id
    await guard(async (session, signal) => {
      const rows = /** @type {any[]} */ (await until(signal, withSpinner(out.ui, 'Loading chats', () => routes.chats.list(client(), state.project.id))))
      const mine = rows.filter((c) => !me || !c.userId || c.userId === me)
      if (!mine.length) return void out.line(style.muted('  No conversations in this project yet. Type a question to start one.'))
      const pick = await until(signal, createPrompts(outFor(session).ui).pick({ message: 'Continue a conversation', options: mine.map((c) => ({ label: String(c.title || 'Untitled'), value: String(c.id), hint: [c.messageCount ? `${c.messageCount} messages` : '', c.updatedAt ? ago(new Date(c.updatedAt).toISOString()) : ''].filter(Boolean).join(' · ') })), maxVisible: 10 }))
      if (pick === BACK) return
      chat = createChat(client(), { project: state.project.id, clientId: clientId(env), mode: state.mode })
      const c = await until(signal, chat.load(pick))
      state.mode = chat.mode
      const cols = term.columns - 1
      out.line(`\n${style.accent(g.dot)} ${style.bold(String(c.title || 'Conversation'))}  ${style.muted(`${chat.history.length} messages · continuing it`)}`)
      for (const h of chat.history.slice(-6)) {
        const lines = wrap(h.text, cols, { first: h.role === 'user' ? `${style.muted(g.pointer)} ` : '  ', indent: '  ', maxLines: h.role === 'user' ? 2 : 4 })
        out.lines(h.role === 'user' ? lines : lines.map((l) => style.muted(l)))
      }
      out.line()
    })
  }

  /** A slash command (or a pasted `kadeep …` line). @param {string} text @returns {Promise<'exit' | void>} */
  async function command(text) {
    const argv = splitArgs(text.replace(/^\//, '').replace(/^kadeep(\s+|$)/, ''))
    if (!argv.length) return help()
    argv[0] = argv[0].toLowerCase()
    const [name, ...rest] = argv
    switch (name) {
      case 'exit':
      case 'quit':
        return 'exit'
      case 'help':
      case '?':
        if (!rest.length) return help()
        break
      case 'clear':
        term.stderr.write('\u001b[2J\u001b[3J\u001b[H')
        return void out.lines(homeLines())
      case 'mcp':
        return mcpHelp()
      case 'mode': {
        const m = /** @type {any} */ (rest[0])
        if (m && !MODES.includes(m)) return void out.line(style.warn('  /mode agent, /mode plan or /mode ask'))
        state.mode = m ?? MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]
        return void out.line(style.muted(`  ${state.mode} mode: ${MODE_HELP[state.mode]}`))
      }
      case 'new':
        chat?.reset()
        state.meter = undefined
        return void out.line(style.muted('  New conversation. The agent starts fresh.'))
      case 'chats':
        return chats()
      case 'open':
        if (!touched.size) return void out.line(style.muted('  Nothing yet: runs, issues and test cases the agent works on in this session show up here.'))
        return screen((s) => s.choose('From this session', [...touched.values()].reverse()))
      case 'search': {
        const q = rest.join(' ') || (await prompts.text({ message: 'Search for' }).catch(() => ''))
        if (!q) return
        const found = (await index.all(), index.search(q))
        if (!found.length) return void out.line(style.muted(`  Nothing matches “${q}”. Ask the agent instead: just type the question.`))
        return screen((s) => s.choose(`Matches for “${q}”`, found.map((x) => ({ kind: x.kind, label: x.label, hint: x.hint, value: x.value }))))
      }
      case 'runs':
        if (!rest.length) return screen((s) => s.runs())
        break
      case 'run':
        if (!rest.length) return screen((s) => s.runWizard())
        break
      case 'suites':
        if (!rest.length) return screen((s) => s.suites())
        break
      case 'tests':
      case 'flows':
      case 'test-cases':
        if (!rest.length) return screen((s) => s.tests())
        break
      case 'suite-runs':
        if (!rest.length) return screen((s) => s.suiteRuns())
        break
      case 'issues':
      case 'defects':
        if (!rest.length) return screen((s) => s.issues())
        break
      case 'project':
      case 'use':
        await cli(['use', ...rest])
        return reload()
      case 'login':
      case 'logout':
        await cli([name, ...rest])
        await reload()
        if (name === 'login' && signedIn() && !state.project.id) await pickProject()
        return
    }
    if (!COMMANDS.some((c) => c.name === name || c.aliases?.includes(name))) return void out.line(style.warn(`  No command /${name}. Type / to see them all.`))
    const code = await cli(argv)
    if (['run', 'init', 'use', 'jobs'].includes(name)) index.refresh()
    if (typeof code === 'number' && code !== EXIT.OK && code !== 130 && code !== EXIT.FAILED) out.line(style.muted(`  (exit ${code})`))
  }

  async function pickProject() {
    out.line(style.muted('  Pick the project to work in (you can switch any time with /project).'))
    await cli(['use'])
    await reload()
  }

  function homeLines() {
    return [
      '',
      `${style.muted(`${g.small} ${g.small} ${g.small}`)}  Ask the KaDeep agent anything ${style.muted('·')} ${style.accent('/')} for commands ${style.muted('·')} type to search`,
      ''
    ]
  }

  function footer() {
    const bits = [
      state.project.id ? style.bold(truncate(state.project.name ?? state.project.id, 32)) : style.warn('no project · /project'),
      `${style.accent(state.mode)} ${style.muted('mode · shift+tab')}`,
      state.email ? style.muted(state.email) : signedIn() ? '' : style.warn('not signed in · /login')
    ].filter(Boolean)
    const m = state.meter
    if (m?.capacity) bits.push(style.muted(`context ${Math.max(1, Math.round((m.used / m.capacity) * 100))}%`))
    return bits.join(style.muted(' · '))
  }

  // ---- start
  await reload()
  await showHeader(out, env, homeText(style, { email: state.email, project: state.project, api }, { session: true }))
  out.lines(homeLines())
  if (!signedIn()) {
    out.line(style.muted('  Sign in to KaDeep Studios to start.'))
    await cli(['login'])
    await reload()
  }
  if (signedIn() && !state.project.id) await pickProject()
  else if (state.project.id) rememberProjectName(env, api, state.project)

  /** @type {number} */
  let code = EXIT.OK
  try {
    for (;;) {
      /** @type {import('../ui/prompts.mjs').CommandLineResult} */
      let r
      try {
        r = await prompts.command({
          palette: PALETTE,
          history,
          search: (q) => index.search(q, 4).map((x) => ({ kind: x.kind, label: x.label, hint: x.hint, value: x.value })),
          footer,
          onShiftTab: () => {
            state.mode = MODES[(MODES.indexOf(state.mode) + 1) % MODES.length]
          },
          placeholder: signedIn() ? 'Ask the KaDeep agent, or type / for commands' : 'Type /login to sign in'
        })
      } catch (err) {
        if (err instanceof KadeepError && err.code === 'cancelled') continue
        throw err
      }
      if (r.kind === 'exit') break
      try {
        if (r.kind === 'open') {
          const v = r.value
          await screen((s) => s.open(/** @type {any} */ (v)))
        } else if (r.kind === 'command') {
          if ((await command(r.text)) === 'exit') break
        } else if (/^kadeep(\s|$)/.test(r.text) || /^(exit|quit|help)$/i.test(r.text)) {
          if ((await command(r.text)) === 'exit') break
        } else await talk(r.text)
      } catch (err) {
        const e = /** @type {Error} */ (err)
        out.error({ message: e?.message ?? String(err) })
        if (env.KADEEP_DEBUG) term.stderr.write(`${e?.stack ?? ''}\n`)
      }
    }
  } catch (err) {
    code = EXIT.FAILED
    out.error({ message: /** @type {Error} */ (err)?.message ?? String(err) })
  } finally {
    releaseBase()
    keys.close()
    streams.stdout.off?.('resize', onResize)
    term.stderr.write('\u001b[?25h')
  }
  out.line(`\n${style.muted(`${g.small} ${g.small} ${g.small}  See you. Your chats are in KaDeep Studios too.`)}`)
  // Anything still running in the background (an interrupted command's last request) must not hold the terminal.
  if (streams.stdin === process.stdin) setTimeout(() => process.exit(code), 200).unref()
  return code
}
