// @ts-check
import { createLive } from './live.mjs'
import { clock, pulse } from './symbols.mjs'

/**
 * Show the dot-pulse spinner with a label and a timer while `fn` runs (rich mode only; otherwise it just runs `fn`).
 * The line is erased when `fn` settles.
 * @template T
 * @param {{ term: import('./term.mjs').Term, style: import('./style.mjs').Style, g: import('./symbols.mjs').Glyphs, rich: boolean }} ui
 * @param {string} label
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withSpinner(ui, label, fn) {
  if (!ui.rich) return fn()
  const started = Date.now()
  const live = createLive(ui.term).start((tick) => [`${ui.style.accent(pulse(ui.g)[tick % 4])}  ${label}  ${ui.style.muted(clock(Date.now() - started))}`])
  try {
    return await fn()
  } finally {
    live.stop({ keep: false })
  }
}
