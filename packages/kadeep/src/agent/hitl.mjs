// @ts-check
import { KadeepError } from '../errors.mjs'
import { createPrompts } from '../ui/prompts.mjs'
import { wrap } from '../ui/style.mjs'

/**
 * When the agent stops to ask you something (a `hitl` event), ask it in the terminal and build the reply the web app
 * would send. Ctrl-C on any of these prompts answers "skip" (the agent carries on without it); it does not stop the
 * turn. Without an interactive terminal (`kadeep ask` in a script) every request is skipped.
 *
 * @typedef {{ text?: string, username?: string, password?: string, dismissed?: boolean }} HitlReply
 */

/** @param {unknown} err */
const cancelled = (err) => err instanceof KadeepError && err.code === 'cancelled'

/**
 * @param {import('../output.mjs').Output} out
 * @param {import('./chat.mjs').AgentEvent} e
 * @returns {Promise<HitlReply>}
 */
export async function askHitl(out, e) {
  if (!out.rich || !out.ui.term.interactive) {
    if (!out.json) out.note(`! The agent asked for ${e.kind === 'question' ? 'answers' : e.kind}; skipped because this terminal is not interactive.`)
    return { dismissed: true, text: 'Not answered: kadeep ran without an interactive terminal.' }
  }
  const { style, g, term } = out.ui
  const p = createPrompts(out.ui)
  const cols = Math.max(20, term.columns) - 4
  /** @param {string} text */
  const say = (text) => term.stderr.write(`${wrap(text, cols, { first: `  ${style.warn(g.dot)} `, indent: '    ' }).join('\n')}\n`)
  const reason = String(e.reason ?? '')
  try {
    if (e.kind === 'question' && Array.isArray(e.questions) && e.questions.length) {
      const context = reason.split('\n').find((l) => l.trim() && !/^q\d+\./i.test(l.trim()))
      if (context) say(context)
      /** @type {string[]} */
      const answers = []
      for (const q of e.questions) {
        let answer
        if (q.options?.length) {
          const TYPE = Symbol('type')
          const choice = await p.select({ message: String(q.text), options: [...q.options.map((/** @type {string} */ o) => ({ label: o, value: /** @type {string | symbol} */ (o) })), { label: 'Type my own answer', value: TYPE }, { label: 'You decide', value: 'you decide' }] })
          answer = choice === TYPE ? await p.text({ message: String(q.text), placeholder: 'your answer' }) : String(choice)
        } else answer = await p.text({ message: String(q.text), placeholder: 'your answer (enter: you decide)' })
        answers.push(`${q.text}\n→ ${answer || 'you decide'}`)
      }
      return { text: answers.join('\n') }
    }
    say(`${reason}${e.host ? `  (${e.host})` : ''}${e.url ? `\n${e.url}` : ''}`)
    if (e.kind === 'credentials') {
      const username = await p.text({ message: 'Username or email', validate: (v) => (v ? undefined : 'Enter the username') })
      const password = await p.password({ message: 'Password' })
      return { username, password }
    }
    if (e.kind === 'otp') return { text: await p.text({ message: 'Code', validate: (v) => (v ? undefined : 'Enter the code') }) }
    if (e.kind === 'approval') {
      const yes = await p.confirm({ message: 'Let the agent go ahead?', initial: false })
      return { text: yes ? 'yes, proceed' : 'no — do not proceed; record the step as blocked' }
    }
    if (e.kind === 'question') return { text: (await p.text({ message: 'Your answer', placeholder: 'enter: you decide' })) || 'you decide' }
    // captcha, manual, connection: done in KaDeep Studios (its live browser view, its Connect settings).
    const where = e.kind === 'connection' ? 'Connect it in KaDeep Studios (Settings → Connect), then continue.' : 'Do it in KaDeep Studios (the agent\'s live browser view), then continue.'
    say(where)
    const go = await p.select({ message: e.kind === 'captcha' ? 'Solved it?' : 'Done?', options: [{ label: e.kind === 'captcha' ? 'I solved it' : 'Done, continue', value: true }, { label: 'Skip', value: false }] })
    return go ? { text: 'done' } : { dismissed: true }
  } catch (err) {
    if (cancelled(err)) return { dismissed: true }
    throw err
  }
}
