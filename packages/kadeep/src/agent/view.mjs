// @ts-check
import { duration } from '../output.mjs'
import { clock, createLive, pulse, truncate, wrap } from '../ui/index.mjs'
import { createMarkdown } from './markdown.mjs'

/**
 * Drawing an agent turn as it streams.
 *
 * Rich terminals: the reply is word-wrapped markdown, printed line by line as each line completes (the line being
 * written stays in a live region at the bottom), with one line per tool the agent used, cards for the runs, issues
 * and test cases it made, and a pulse with the current step, a timer and how to interrupt.
 * Plain output: the reply text on stdout exactly as it streams; tool calls and cards as short lines on stderr.
 * --json: nothing (the caller prints the turn).
 *
 * @typedef {import('./chat.mjs').AgentEvent} AgentEvent
 * @typedef {import('./chat.mjs').Turn} Turn
 */

const TERMINAL = new Set(['passed', 'failed', 'stopped', 'cancelled', 'error'])

/** A tool call in words, the way the web app labels it. @param {AgentEvent} e */
export function describeTool(e) {
  const a = e.args ?? {}
  const why = typeof a.why === 'string' && a.why ? ` · ${a.why}` : ''
  const first = String(e.result ?? '').split('\n')[0].trim()
  const done = e.result !== undefined
  switch (e.name) {
    case 'navigate':
      return done ? first || `Opened ${a.url ?? ''}` : `Opening ${a.url ?? ''}`
    case 'click':
      return done ? first || `Clicked ${a.ref ?? ''}` : `Clicking ${a.ref ?? ''}${why}`
    case 'type':
    case 'type_variable':
      return done ? first || `Typed into ${a.ref ?? ''}` : `Typing into ${a.ref ?? ''}${why}`
    case 'snapshot':
    case 'screenshot':
      return `Looked at the page${why}`
    case 'propose_plan':
      return `Proposed a plan: ${a.title ?? ''}`
    case 'request_user_help':
    case 'ask_user':
      return done ? 'Got your answer' : 'Asking you'
    case 'spawn_agent':
      return `Delegated to ${a.agent ?? 'a sub-agent'}`
    default:
      return done ? first || String(e.name).replace(/_/g, ' ') : `${String(e.name).replace(/_/g, ' ')}${why}`
  }
}

/**
 * @param {import('../output.mjs').Output} out
 * @param {{ interruptHint?: string }} [opts]
 */
export function turnView(out, opts = {}) {
  const { term, style, g } = out.ui
  const started = Date.now()
  /** @type {Set<string>} */
  const said = new Set()
  /** Print a line about a thing once (runs and emails repeat as they change). @param {string} key */
  const once = (key) => (said.has(key) ? false : (said.add(key), true))

  if (!out.rich) {
    let seen = ''
    let wroteText = false
    /** @param {string} line */
    const note = (line) => {
      if (!out.json) out.note(line)
    }
    return {
      /** @param {AgentEvent} e @param {Turn} turn */
      event(e, turn) {
        if (out.json) return
        if (e.type === 'delta' || e.type === 'token') {
          const fresh = turn.text.startsWith(seen) ? turn.text.slice(seen.length) : `\n${turn.text}`
          seen = turn.text
          if (fresh) {
            term.stdout.write(fresh)
            wroteText = true
          }
          return
        }
        const line = plainLine(e, once)
        if (line) note(line)
      },
      pause() {},
      resume() {},
      /** @param {Turn} turn */
      done(turn) {
        if (out.json) return
        if (wroteText && !seen.endsWith('\n')) term.stdout.write('\n')
        if (turn.stopped) note('Stopped.')
      }
    }
  }

  const cols = () => Math.max(20, term.stdout.columns || term.columns)
  const md = createMarkdown(style, g, () => cols() - 2)
  let seen = ''
  let pending = ''
  let first = true
  let label = 'Thinking'
  /** @type {Map<string, string>} */
  const running = new Map()
  const live = createLive(term, { exitOnInterrupt: false })
  const hint = opts.interruptHint ?? 'esc to interrupt'
  const region = (/** @type {number} */ tick) => {
    const lines = pending ? wrap(pending, cols() - 3).map((l, i) => `${i === 0 && first ? style.accent(g.dot) : ' '} ${l}`).slice(-3) : []
    const step = [...running.values()].pop() ?? label
    const time = clock(Date.now() - started)
    lines.push(`${style.accent(pulse(g)[tick % 4])}  ${truncate(step, Math.max(10, cols() - 30))}  ${style.muted(`${time} · ${hint}`)}`)
    return lines
  }
  live.start(region)

  let opened = false
  /** Lines above the live region; the turn opens with a blank line under your message. @param {string[]} lines */
  const print = (lines) => {
    if (!opened && lines.length) {
      opened = true
      lines = ['', ...lines]
    }
    live.print(lines)
  }
  /** Text lines of the reply: the first gets KaDeep's dot, the rest a margin. @param {string[]} lines */
  const printText = (lines) => {
    print(lines.map((l) => (first && l ? ((first = false), `${style.accent(g.dot)} ${l}`) : l ? `  ${l}` : '')))
  }
  const flushPending = () => {
    if (!pending) return
    printText(md.line(pending))
    pending = ''
  }
  /** A line about something the agent did, below any unfinished text. @param {string} line */
  const act = (line) => {
    flushPending()
    print([`  ${line}`])
  }

  return {
    /** @param {AgentEvent} e @param {Turn} turn */
    event(e, turn) {
      switch (e.type) {
        case 'delta':
        case 'token': {
          const fresh = turn.text.startsWith(seen) ? turn.text.slice(seen.length) : `\n${turn.text}`
          seen = turn.text
          pending += fresh
          const parts = pending.split('\n')
          pending = /** @type {string} */ (parts.pop())
          for (const l of parts) printText(md.line(l))
          break
        }
        case 'status':
          label = String(e.message ?? label)
          break
        case 'thinking':
          if (!e.delta && e.message) label = String(e.message).split('\n')[0]
          break
        case 'tool': {
          if (e.result === undefined) {
            flushPending()
            running.set(e.id, describeTool(e))
            break
          }
          running.delete(e.id)
          if (e.name === 'snapshot' || e.name === 'screenshot') break
          act(`${e.ok === false ? style.fail(g.fail) : style.ok(g.ok)} ${style.muted(truncate(describeTool(e), cols() - 6))}`)
          break
        }
        case 'agent':
          if (e.status === 'start') act(`${style.accent(g.dot)} ${style.bold(String(e.name))}${e.task ? style.muted(`  ${truncate(String(e.task), cols() - 10 - String(e.name).length)}`) : ''}`)
          break
        case 'run': {
          const r = e.run ?? {}
          if (!TERMINAL.has(r.status)) {
            label = `Running ${r.flowName ?? 'a test'}`
            break
          }
          if (once(`run:${r.id}`)) act(`${r.status === 'passed' ? style.ok(g.ok) : style.fail(g.fail)} ${style.bold(r.flowName ?? 'Run')}  ${r.verdict && r.verdict !== 'PASS' ? style.fail(r.verdict) : style.muted(r.status)}  ${style.muted(`${duration(r.durationMs)} · ${r.id}`)}`)
          break
        }
        case 'issue':
          if (once(`issue:${e.issue?.id}`)) act(`${style.warn(g.warn)} Issue ${style.bold(String(e.issue?.title ?? ''))}  ${style.muted(`${e.issue?.severity ?? ''} · ${e.issue?.id ?? ''}`)}`)
          break
        case 'flow':
          if (once(`flow:${e.flow?.id}`)) act(`${style.accent(g.dot)} Test case ${style.bold(String(e.flow?.name ?? ''))}  ${style.muted(String(e.flow?.key ?? e.flow?.id ?? ''))}`)
          break
        case 'artifact':
          if (once(`artifact:${e.artifact?.id}`)) act(`${style.accent(g.dot)} Saved ${e.artifact?.kind ?? 'file'} ${style.bold(String(e.artifact?.title ?? e.artifact?.fileName ?? ''))}  ${style.muted('open it in KaDeep Studios')}`)
          break
        case 'email':
          if (once(`email:${e.draft?.id}:${e.draft?.status}`)) act(`${style.accent(g.dot)} Email ${e.draft?.status === 'sent' ? 'sent' : 'draft'} ${style.bold(String(e.draft?.subject ?? ''))}  ${style.muted(e.draft?.status === 'draft' ? 'review and send it in KaDeep Studios' : String(e.draft?.status ?? ''))}`)
          break
        case 'campaign':
          if (once(`campaign:${e.campaign?.id}`)) act(`${style.warn(g.warn)} Campaign ${style.bold(String(e.campaign?.name ?? e.campaign?.title ?? ''))}  ${style.muted('approve it in KaDeep Studios')}`)
          break
        case 'approval:request':
          if (e.request?.status === 'pending' && once(`approval:${e.request?.id}`)) act(`${style.warn(g.warn)} Approval needed: ${style.bold(String(e.request?.title ?? ''))}  ${style.muted('KaDeep Studios → Runs → Approvals')}`)
          break
        case 'budget:checkpoint':
          act(`${style.warn(g.warn)} ${e.checkpoint?.action === 'paused' ? 'Campaign paused at its budget cap: decide in KaDeep Studios' : `${e.checkpoint?.pct}% of the campaign budget used`}`)
          break
        case 'loc:job':
          if (once(`loc:${e.jobId}`)) act(`${style.loc(g.dot)} Localization job ${style.bold(String(e.title ?? ''))}`)
          break
        case 'chart':
          act(`${style.accent(g.dot)} Chart ${style.bold(String(e.chart?.title ?? ''))}  ${style.muted('view it in KaDeep Studios')}`)
          break
        case 'desktop':
          if (e.state === 'acting' && e.action) label = `Desktop: ${e.action}`
          break
        case 'compaction':
          act(style.muted('Earlier messages were summarized to keep the conversation small.'))
          break
        case 'provider':
          act(style.muted(`Switched to ${e.model ?? e.to}`))
          break
        case 'plan':
          flushPending()
          print(['', `  ${style.accent(g.dot)} ${style.bold(`Plan: ${e.plan?.title ?? ''}`)}`, ...String(e.plan?.markdown ?? '').split('\n').flatMap((l) => md.line(l)).map((l) => (l ? `    ${l}` : ''))])
          break
        case 'llm':
          act(`${style.warn(g.warn)} ${e.message ?? 'The model call failed.'}`)
          break
        case 'error':
          act(`${style.fail(g.fail)} ${style.fail(String(e.message ?? 'The agent failed'))}`)
          break
      }
      live.update()
    },
    /** Clear the live region (a question is about to be asked). */
    pause() {
      flushPending()
      live.stop({ keep: false })
    },
    resume() {
      live.start(region)
    },
    /** @param {Turn} turn */
    done(turn) {
      flushPending()
      live.stop({ keep: false })
      if (turn.stopped) print([`  ${style.muted('Stopped. Anything the agent started on KaDeep (runs, jobs) keeps going.')}`])
      print([''])
    }
  }
}

/**
 * The stderr line plain output prints for an event (not the reply text), or nothing.
 * @param {AgentEvent} e
 * @param {(key: string) => boolean} once
 */
function plainLine(e, once) {
  switch (e.type) {
    case 'tool':
      return e.result !== undefined && e.name !== 'snapshot' && e.name !== 'screenshot' ? `  ${e.ok === false ? 'x' : '-'} ${describeTool(e).slice(0, 200)}` : ''
    case 'run':
      return TERMINAL.has(e.run?.status) && once(`run:${e.run?.id}`) ? `  run ${e.run?.status}: ${e.run?.flowName ?? ''} (${e.run?.id})` : ''
    case 'issue':
      return once(`issue:${e.issue?.id}`) ? `  issue: ${e.issue?.title ?? ''} (${e.issue?.severity ?? ''}, ${e.issue?.id ?? ''})` : ''
    case 'flow':
      return once(`flow:${e.flow?.id}`) ? `  test case: ${e.flow?.name ?? ''} (${e.flow?.key ?? e.flow?.id ?? ''})` : ''
    case 'artifact':
      return once(`artifact:${e.artifact?.id}`) ? `  saved: ${e.artifact?.title ?? e.artifact?.fileName ?? ''}` : ''
    case 'plan':
      return `\nPlan: ${e.plan?.title ?? ''}\n${e.plan?.markdown ?? ''}`
    case 'llm':
      return `! ${e.message ?? 'The model call failed.'}`
    case 'error':
      return `✗ ${e.message ?? 'The agent failed'}`
    default:
      return ''
  }
}
