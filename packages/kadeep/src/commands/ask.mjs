// @ts-check
import { routes } from '../api.mjs'
import { clientId } from '../config.mjs'
import { EXIT, KadeepError, usage } from '../errors.mjs'
import { createChat, llmProblem, MODES } from '../agent/chat.mjs'
import { converse } from '../agent/converse.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/**
 * A turn as one JSON document: what the agent said and what it did, without the raw records.
 * @param {import('../agent/chat.mjs').Turn} t
 */
export const turnJson = (t) => ({
  chatId: t.chatId,
  mode: t.mode,
  text: t.text,
  stopped: t.stopped,
  ...(t.error ? { error: t.error } : {}),
  ...(t.llm ? { llm: t.llm } : {}),
  tools: t.tools.map((x) => ({ name: x.name, ok: x.ok, result: x.result === undefined ? undefined : String(x.result).split('\n')[0] })),
  runs: t.runs.map((r) => ({ id: r.id, test: r.flowName, status: r.status, verdict: r.verdict })),
  issues: t.issues.map((i) => ({ id: i.id, title: i.title, severity: i.severity })),
  tests: t.flows.map((f) => ({ id: f.id, key: f.key, name: f.name })),
  artifacts: t.artifacts.map((a) => ({ id: a.id, title: a.title, kind: a.kind, path: a.path })),
  ...(t.plan ? { plan: { id: t.plan.id, title: t.plan.title, status: t.plan.status, markdown: t.plan.markdown } } : {})
})

/** @type {Command} */
const ask = {
  name: 'ask',
  summary: 'Ask the KaDeep agent and stream its answer (it can also act)',
  usage: [
    'kadeep ask "<message>" [--mode agent|plan|ask] [--chat <id>]',
    'kadeep ask "Why did the checkout test fail yesterday?"',
    'kadeep ask --mode ask "Which suites cover payments?"        # answers only, changes nothing',
    'Modes: agent acts (runs tests, drives the browser, files issues) · plan proposes a plan to approve · ask only answers.',
    'The chat is saved in the project, so it also shows in KaDeep Studios. Continue one with --chat <id>, or run `kadeep`.'
  ],
  options: { mode: { type: 'string' }, chat: { type: 'string' } },
  async run({ values, positionals, out, client, project, env, signal: outer }) {
    const message = positionals.join(' ').trim()
    if (!message) throw usage('Pass a message: kadeep ask "Why did the checkout test fail?"')
    const mode = /** @type {import('../agent/chat.mjs').AgentMode} */ (values.mode ?? 'agent')
    if (!MODES.includes(mode)) throw usage('--mode must be agent, plan or ask')
    const c = client('user')
    const p = await project(c)
    const problem = llmProblem(await routes.llm(c).catch(() => null))
    if (problem) throw new KadeepError(problem, { code: 'llm_unavailable', exitCode: EXIT.USAGE })
    const chat = createChat(c, { project: p.id, clientId: clientId(env), mode })
    if (values.chat) await chat.load(values.chat)
    if (values.mode) chat.mode = mode

    // Ctrl-C stops the turn on KaDeep (the session passes its own signal instead).
    const ac = new AbortController()
    const onSigint = () => ac.abort()
    if (!outer) process.on('SIGINT', onSigint)
    /** @type {import('../agent/chat.mjs').Turn[]} */
    let turns
    try {
      turns = await converse(out, chat, message, { signal: outer ?? ac.signal, interruptHint: outer ? 'esc to interrupt' : 'ctrl-c to stop' })
    } finally {
      process.off('SIGINT', onSigint)
    }
    const last = turns[turns.length - 1]
    out.result(turns.length === 1 ? turnJson(last) : { ...turnJson(last), turns: turns.map(turnJson) }, () => {
      if (out.rich && !outer) out.line(out.c.muted(`  chat ${chat.chatId} · continue it: kadeep ask --chat ${chat.chatId} "…" · or just run kadeep`))
    })
    if (last.stopped) return 130
    return last.error || last.llm ? EXIT.FAILED : EXIT.OK
  }
}

export default [ask]
