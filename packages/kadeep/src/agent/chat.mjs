// @ts-check
import { routes } from '../api.mjs'
import { KadeepError } from '../errors.mjs'
import { createSseParser } from './sse.mjs'

/**
 * The KaDeep agent from the terminal: the same agent, tools and chats as the KaDeep Studios web app, over its HTTP
 * API. No UI here; the interactive session and `kadeep ask` draw the events.
 *
 *   POST /api/chats              a chat for the project (saved on KaDeep, so it also shows in the web app)
 *   POST /api/agent/chat         one turn, streamed back as Server-Sent Events
 *   POST /api/agent/hitl         answer a question or a credentials request the agent is waiting on
 *   POST /api/agent/plan/:id     approve or reject a plan the agent proposed
 *   POST /api/agent/stop         interrupt the turn
 *
 * Modes, as in the web app: `agent` acts (runs tests, drives the browser, files issues), `plan` proposes a plan to
 * approve first, `ask` only answers.
 *
 * @typedef {import('../client.mjs').Client} Client
 * @typedef {'agent' | 'plan' | 'ask'} AgentMode
 * @typedef {{ type: string, [k: string]: any }} AgentEvent
 * @typedef {{ role: 'user' | 'agent', text: string }} HistoryItem
 * @typedef {{ id: string, name: string, args?: Record<string, unknown>, result?: string, ok?: boolean }} ToolCall
 * @typedef {{
 *   chatId: string,
 *   mode: AgentMode,
 *   text: string,
 *   tools: ToolCall[],
 *   runs: any[],
 *   issues: any[],
 *   flows: any[],
 *   artifacts: any[],
 *   plan?: any,
 *   error?: string,
 *   llm?: { code: string, message: string, source?: string },
 *   meter?: any,
 *   stopped: boolean
 * }} Turn
 */

/** @type {AgentMode[]} */
export const MODES = ['agent', 'plan', 'ask']

/** What each mode does, for the footer and help. */
export const MODE_HELP = { agent: 'acts: runs tests, drives the browser, files issues', plan: 'proposes a plan for you to approve first', ask: 'answers only, changes nothing' }

/** The history the web app sends with a turn: the last 12 messages that have text. */
const HISTORY = 12

/**
 * Fold one event into the turn's record (the text so far, tool calls, and what the agent made).
 * @param {Turn} turn
 * @param {AgentEvent} e
 */
export function absorb(turn, e) {
  /** @param {any[]} list @param {any} item */
  const upsert = (list, item) => {
    if (!item?.id) return
    const at = list.findIndex((x) => x.id === item.id)
    if (at >= 0) list[at] = { ...list[at], ...item }
    else list.push(item)
  }
  switch (e.type) {
    case 'delta':
      turn.text += String(e.text ?? '')
      break
    case 'token':
      turn.text = String(e.text ?? '')
      break
    case 'tool':
      upsert(turn.tools, { id: e.id, name: e.name, ...(e.args ? { args: e.args } : {}), ...(e.result !== undefined ? { result: e.result, ok: e.ok } : {}) })
      break
    case 'run':
      upsert(turn.runs, e.run)
      break
    case 'issue':
      upsert(turn.issues, e.issue)
      break
    case 'flow':
      upsert(turn.flows, e.flow)
      break
    case 'artifact':
      upsert(turn.artifacts, e.artifact)
      break
    case 'plan':
      turn.plan = e.plan
      break
    case 'context':
      turn.meter = e.meter
      break
    case 'llm':
      turn.llm = { code: e.code, message: e.message, source: e.source }
      break
    case 'error':
      turn.error = String(e.message ?? 'The agent failed')
      break
  }
}

/** Whether the user's model key is usable, from `GET /api/settings/llm`; a reason when it is not. @param {any} status */
export function llmProblem(status) {
  const s = status?.llm
  if (!s) return undefined
  if (!s.configured) return 'Add your OpenRouter API key in KaDeep Studios (Settings → Models) so the agent can answer.'
  const code = s.lastIssue?.code
  if (code === 'invalid') return 'OpenRouter rejected your API key. Replace it in KaDeep Studios (Settings → Models).'
  if (code === 'credits') return s.source === 'shared' ? 'The shared model key is out of credits. Add your own OpenRouter key in KaDeep Studios (Settings → Models).' : 'Your OpenRouter key is out of credits. Add credits at openrouter.ai/settings/credits.'
  if (code === 'missing') return 'Add your OpenRouter API key in KaDeep Studios (Settings → Models).'
  return undefined
}

/**
 * A conversation with the KaDeep agent in one project.
 * @param {Client} client  a login (the agent acts as you; a CI token cannot chat)
 * @param {{ project: string, clientId: string, mode?: AgentMode, chatId?: string }} opts
 */
export function createChat(client, opts) {
  let chatId = opts.chatId ?? ''
  /** @type {AgentMode} */
  let mode = opts.mode ?? 'agent'
  /** @type {HistoryItem[]} */
  let history = []

  const chat = {
    get chatId() {
      return chatId
    },
    get mode() {
      return mode
    },
    set mode(m) {
      mode = m
    },
    get history() {
      return history
    },

    /**
     * Send one message and follow the turn to its end. `onEvent` sees every event as it arrives (after it is folded
     * into the turn). Aborting `signal` stops the turn on KaDeep and resolves with `stopped: true`.
     * @param {string} message
     * @param {{ onEvent?: (e: AgentEvent, turn: Turn) => void, signal?: AbortSignal, approvedPlan?: any }} [o]
     * @returns {Promise<Turn>}
     */
    async send(message, o = {}) {
      if (client.auth.kind === 'ci') throw new KadeepError('The KaDeep agent needs a login (`kadeep login`); a CI token cannot chat.', { code: 'auth_required', exitCode: 2 })
      const turnMode = o.approvedPlan ? 'agent' : mode
      if (!chatId) chatId = (await routes.chats.create(client, { projectId: opts.project, mode: turnMode })).id
      /** @type {Turn} */
      const turn = { chatId, mode: turnMode, text: '', tools: [], runs: [], issues: [], flows: [], artifacts: [], stopped: false }
      const parser = createSseParser((e) => {
        absorb(turn, e)
        o.onEvent?.(e, turn)
      })
      const body = { message, projectId: opts.project, chatId, clientId: opts.clientId, mode: turnMode, attachments: [], history: history.filter((h) => h.text).slice(-HISTORY), ...(o.approvedPlan ? { approvedPlan: o.approvedPlan } : {}) }
      try {
        await routes.agent.chat(client, body, (text) => parser.push(text), { signal: o.signal })
      } catch (err) {
        if (!o.signal?.aborted) throw err
        turn.stopped = true
        await chat.stop()
      }
      history.push({ role: 'user', text: o.approvedPlan ? `Approved plan: ${o.approvedPlan.title}` : message }, { role: 'agent', text: turn.text || (turn.stopped ? 'Stopped.' : '') })
      return turn
    },

    /**
     * Answer what the agent asked (`hitl` event): `{ text }`, `{ username, password }` or `{ dismissed: true }`.
     * @param {string} requestId
     * @param {{ text?: string, username?: string, password?: string, dismissed?: boolean }} reply
     */
    answer: (requestId, reply) => routes.agent.hitl(client, { clientId: opts.clientId, requestId, ...reply }),

    /**
     * Approve or reject a proposed plan. Approving switches the chat to agent mode; send the plan back with
     * `send('', { approvedPlan })` to carry it out, as the web app does.
     * @param {any} plan
     * @param {'approve' | 'reject'} decision
     */
    async decide(plan, decision) {
      const res = await routes.agent.plan(client, plan.id, { clientId: opts.clientId, decision }).catch(() => null)
      if (decision === 'approve') mode = 'agent'
      return res?.plan ?? { ...plan, status: decision === 'approve' ? 'approved' : 'rejected' }
    },

    /** Interrupt the running turn on KaDeep. */
    stop: () => routes.agent.stop(client, opts.clientId).catch(() => null),

    /** Continue an earlier chat: its messages become the history the next turn is sent with. @param {string} id */
    async load(id) {
      const c = await routes.chats.get(client, id)
      chatId = c.id
      if (c.mode && MODES.includes(c.mode)) mode = c.mode
      history = (c.messages ?? []).filter((/** @type {any} */ m) => m.text && (m.role === 'user' || m.role === 'agent')).map((/** @type {any} */ m) => ({ role: m.role, text: String(m.text) }))
      return c
    },

    /** Start over: the next message opens a new chat. */
    reset() {
      chatId = ''
      history = []
    }
  }
  return chat
}

/** @typedef {ReturnType<typeof createChat>} Chat */
