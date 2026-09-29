// @ts-check
import { createPrompts } from '../ui/prompts.mjs'
import { askHitl } from './hitl.mjs'
import { turnView } from './view.mjs'

/**
 * One exchange with the KaDeep agent, drawn in the terminal: send the message, render the reply as it streams, ask
 * whatever the agent asks on the way, and when the reply is a plan (plan mode), ask whether to approve it; approving
 * carries it out in a second turn, as in the web app.
 *
 * Events are handled in order through one queue, so nothing is drawn while a question is on screen.
 *
 * @param {import('../output.mjs').Output} out
 * @param {import('./chat.mjs').Chat} chat
 * @param {string} message
 * @param {{ signal?: AbortSignal, interruptHint?: string, approvedPlan?: any }} [opts]
 * @returns {Promise<import('./chat.mjs').Turn[]>} every turn, in order (two when a plan was approved and run)
 */
export async function converse(out, chat, message, opts = {}) {
  const view = turnView(out, { interruptHint: opts.interruptHint })
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve()
  const turn = await chat
    .send(message, {
      signal: opts.signal,
      approvedPlan: opts.approvedPlan,
      onEvent: (e, t) => {
        queue = queue.then(async () => {
          if (e.type !== 'hitl') return view.event(e, t)
          view.pause()
          try {
            const reply = await askHitl(out, e)
            await chat.answer(e.requestId, reply).catch((err) => out.warn(`Could not send your answer: ${err.message}`))
          } finally {
            if (!opts.signal?.aborted) view.resume()
          }
        })
      }
    })
    .catch(async (err) => {
      await queue.catch(() => {})
      view.done({ chatId: chat.chatId, mode: chat.mode, text: '', tools: [], runs: [], issues: [], flows: [], artifacts: [], stopped: false })
      throw err
    })
  await queue.catch(() => {})
  view.done(turn)
  const turns = [turn]

  const plan = turn.plan
  if (plan && plan.status === 'proposed' && !turn.stopped && out.rich && out.ui.term.interactive) {
    const p = createPrompts(out.ui)
    const choice = await p.select({
      message: 'Plan',
      options: [
        { label: 'Approve and run it', value: 'approve', hint: 'the agent carries it out now' },
        { label: 'Keep planning', value: 'keep', hint: 'type what to change' },
        { label: 'Reject it', value: 'reject' }
      ]
    }).catch(() => 'keep')
    if (choice === 'approve') {
      const approved = await chat.decide(plan, 'approve')
      turns.push(...(await converse(out, chat, '', { ...opts, approvedPlan: approved })))
    } else if (choice === 'reject') await chat.decide(plan, 'reject')
  }
  return turns
}
