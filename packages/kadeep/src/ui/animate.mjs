// @ts-check
import { createLive } from './live.mjs'
import { header, MARK_DOTS } from './logo.mjs'

/**
 * The logo's dots light up left to right (about 0.4 s), then the full header stays on screen. The caller decides
 * when this may run: rich mode, colors on, first run only, never in CI.
 * @param {import('./term.mjs').Term} term
 * @param {import('./symbols.mjs').Glyphs} g
 * @param {import('./style.mjs').Style} style
 * @param {Array<string | undefined>} text
 * @param {{ durationMs?: number }} [opts]
 * @returns {Promise<void>}
 */
export function dotFill(term, g, style, text, opts = {}) {
  const duration = opts.durationMs ?? 400
  const started = Date.now()
  const live = createLive(term, { fps: 40 })
  return new Promise((resolve) => {
    live.start(() => {
      const lit = new Set(MARK_DOTS.slice(0, Math.ceil(Math.min(1, (Date.now() - started) / duration) * MARK_DOTS.length)).map(([r, c]) => `${r},${c}`))
      return header(term, g, style, text, (r, c) => lit.has(`${r},${c}`))
    })
    setTimeout(() => {
      live.stop({ keep: true })
      resolve()
    }, duration + 50)
  })
}
