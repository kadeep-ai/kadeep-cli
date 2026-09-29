// @ts-check
import { truncate } from './style.mjs'

const HIDE = '\u001b[?25l'
const SHOW = '\u001b[?25h'

/**
 * A region at the bottom of the terminal that redraws in place (spinners, dot strips). It draws on stderr, so stdout
 * keeps only results; lines are cut to the terminal width so a redraw never wraps. The cursor is hidden while it runs
 * and always shown again: on stop, on exit, and on Ctrl-C (after `onInterrupt`, the process exits with 130).
 *
 * Only for rich mode; callers check `term.mode` first.
 *
 * @param {import('./term.mjs').Term} term
 * @param {{ fps?: number, onInterrupt?: () => void }} [opts]
 */
export function createLive(term, opts = {}) {
  const out = term.stderr
  const every = Math.round(1000 / (opts.fps ?? 12))
  let rendered = 0
  let tick = 0
  let active = false
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let timer
  /** @type {(tick: number) => string[]} */
  let render = () => []

  const cols = () => Math.max(20, term.stdout.columns || term.columns) - 1
  const restore = () => out.write(SHOW)
  const onSigint = () => {
    live.stop({ keep: true })
    opts.onInterrupt?.()
    process.exit(130)
  }

  /** @param {string[]} lines */
  function paint(lines) {
    const body = lines.map((l) => truncate(l, cols()))
    out.write(`${rendered ? `\u001b[${rendered}F\u001b[J` : ''}${body.length ? `${body.join('\n')}\n` : ''}`)
    rendered = body.length
  }

  const live = {
    /** Start drawing `fn(tick)` about 12 times a second. @param {(tick: number) => string[]} fn */
    start(fn) {
      render = fn
      if (active) return live
      active = true
      out.write(HIDE)
      process.once('exit', restore)
      process.on('SIGINT', onSigint)
      paint(render(tick++))
      timer = setInterval(() => paint(render(tick++)), every)
      timer.unref?.()
      return live
    },
    /** Redraw now (optionally with a new render function). @param {(tick: number) => string[]} [fn] */
    update(fn) {
      if (fn) render = fn
      if (active) paint(render(tick))
    },
    /**
     * Write lines permanently above the region (to stdout by default), then redraw the region under them.
     * @param {string[]} lines
     * @param {NodeJS.WritableStream} [stream]
     */
    print(lines, stream = term.stdout) {
      if (active && rendered) {
        out.write(`\u001b[${rendered}F\u001b[J`)
        rendered = 0
      }
      if (lines.length) stream.write(`${lines.join('\n')}\n`)
      if (active) paint(render(tick))
    },
    /** Stop redrawing; keep the last frame on screen (default) or erase it. @param {{ keep?: boolean }} [o] */
    stop(o = {}) {
      if (!active) return
      clearInterval(timer)
      if (o.keep === false) paint([])
      else paint(render(tick))
      rendered = 0
      active = false
      out.write(SHOW)
      process.off('SIGINT', onSigint)
      process.off('exit', restore)
    },
    get active() {
      return active
    }
  }
  return live
}
