// @ts-check
import { EXIT, KadeepError } from '../errors.mjs'
import { parseKeys } from './keys.mjs'
import { truncate, width, wrap } from './style.mjs'

export { parseKeys }

/**
 * Arrow-key prompts drawn on stderr: select (type to filter), multiselect, confirm, text, a masked password, and the
 * interactive session's command line. The active step is a hollow accent dot, an answered step a solid green one.
 * Ctrl-C restores the terminal and rejects with a `cancelled` error (exit 130). Needs an interactive terminal;
 * commands check `term.interactive` and fall back to flags (or plain line prompts) otherwise. Inside the session,
 * keys come from the session's input hub instead of stdin directly.
 *
 * @typedef {{ term: import('./term.mjs').Term, style: import('./style.mjs').Style, g: import('./symbols.mjs').Glyphs }} Ui
 * @typedef {{ label: string, value: unknown, hint?: string }} Option
 * @typedef {import('./keys.mjs').Key} Key
 * @typedef {{ name: string, summary: string, usage?: string }} PaletteItem
 * @typedef {{ kind: string, label: string, hint?: string, value: unknown }} SearchMatch
 * @typedef {{
 *   palette: PaletteItem[],
 *   history?: string[],
 *   search?: (text: string) => SearchMatch[],
 *   footer?: () => string,
 *   onShiftTab?: () => void,
 *   placeholder?: string
 * }} CommandLineOptions
 * @typedef {{ kind: 'text' | 'command', text: string } | { kind: 'open', value: unknown, label: string } | { kind: 'exit' }} CommandLineResult
 */

/** What `select({ back: true })` resolves to when the user presses Esc: go back one screen. */
export const BACK = Symbol('back')

const HIDE = '\u001b[?25l'
const SHOW = '\u001b[?25h'
/** The command line draws its own cursor (the terminal's is hidden while prompts redraw). @param {string} ch */
const cursorCell = (ch) => `\u001b[7m${ch}\u001b[27m`

/** The end of a string that fits in `n` columns. @param {string} s @param {number} n */
function tail(s, n) {
  const cs = [...s]
  let out = ''
  for (let i = cs.length - 1; i >= 0 && width(cs[i] + out) <= n; i--) out = cs[i] + out
  return out
}

/**
 * The shared loop: draw, read keys, redraw, finish with the answered line.
 * @template T
 * @param {Ui} ui
 * @param {{ view: () => string[], key: (k: Key) => { value: T, final: string[] } | void, cancelled: () => string[], ownCtrlC?: boolean }} spec
 *   `ownCtrlC`: Ctrl-C and Ctrl-D go to `key` instead of cancelling (the session's command line)
 * @returns {Promise<T>}
 */
function interact(ui, spec) {
  const { stdin, stderr } = ui.term
  const hub = ui.term.session?.keys
  if (ui.term.session?.signal?.aborted) return Promise.reject(new KadeepError('Cancelled', { code: 'cancelled', exitCode: 130 }))
  if (!ui.term.interactive || (!hub && typeof stdin.setRawMode !== 'function')) return Promise.reject(new KadeepError('This prompt needs an interactive terminal; pass the value as a flag instead.', { code: 'usage', exitCode: EXIT.USAGE }))
  let rendered = 0
  const cols = () => Math.max(20, ui.term.stdout.columns || ui.term.columns) - 1
  /** @param {string[]} lines */
  const draw = (lines) => {
    stderr.write(`${rendered ? `\u001b[${rendered}F\u001b[J` : ''}${lines.map((l) => truncate(l, cols())).join('\n')}${lines.length ? '\n' : ''}`)
    rendered = lines.length
  }
  return new Promise((resolve, reject) => {
    let settled = false
    /** @type {() => void} */
    let release = () => {}
    const cleanup = () => {
      settled = true
      release()
      stderr.write(SHOW)
    }
    /** @param {Key} k @returns {boolean} true once the prompt is answered */
    const handle = (k) => {
      if (settled) return true
      if ((k === 'ctrl-c' || k === 'ctrl-d') && !spec.ownCtrlC) {
        draw(spec.cancelled())
        cleanup()
        reject(new KadeepError('Cancelled', { code: 'cancelled', exitCode: 130 }))
        return true
      }
      const done = spec.key(k)
      if (!done) return false
      draw(done.final)
      cleanup()
      resolve(done.value)
      return true
    }
    if (hub) {
      release = hub.push((k) => {
        if (!handle(k)) draw(spec.view())
      })
    } else {
      const restore = () => {
        try {
          stdin.setRawMode(false)
        } catch {
          /* already closed */
        }
        stderr.write(SHOW)
      }
      /** @param {string | Buffer} chunk */
      const onData = (chunk) => {
        for (const k of parseKeys(String(chunk))) if (handle(k)) return
        draw(spec.view())
      }
      release = () => {
        stdin.off('data', onData)
        stdin.setRawMode(false)
        stdin.pause()
        process.off('exit', restore)
      }
      process.once('exit', restore)
      stdin.setRawMode(true)
      stdin.setEncoding('utf8')
      stdin.resume()
      stdin.on('data', onData)
    }
    stderr.write(HIDE)
    draw(spec.view())
  })
}

/** @param {Ui} ui */
export function createPrompts(ui) {
  const { style, g } = ui
  const active = (/** @type {string} */ m) => `${style.accent(g.hollow)} ${style.bold(m)}`
  const answered = (/** @type {string} */ m, /** @type {string} */ v) => [`${style.ok(g.dot)} ${m}  ${style.accent(v)}`]
  const cancelled = (/** @type {string} */ m) => () => [`${style.fail(g.dot)} ${m}  ${style.muted('cancelled')}`]
  const rail = style.muted(g.v)

  /**
   * @template T
   * @param {{ message: string, options: Array<{ label: string, value: T, hint?: string }>, initial?: number, maxVisible?: number, back: boolean }} o
   * @returns {Promise<T | typeof BACK>}
   */
  function choose(o) {
    const filterable = o.options.length > 7
    const max = o.maxVisible ?? 8
    let filter = ''
    let cursor = Math.max(0, Math.min(o.initial ?? 0, o.options.length - 1))
    let offset = 0
    const list = () => (filter ? o.options.filter((x) => `${x.label} ${x.hint ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : o.options)
    return /** @type {Promise<T | typeof BACK>} */ (interact(ui, {
      view() {
        const items = list()
        cursor = Math.min(cursor, Math.max(0, items.length - 1))
        if (cursor < offset) offset = cursor
        if (cursor >= offset + max) offset = cursor - max + 1
        const shown = items.slice(offset, offset + max)
        const head = `${active(o.message)}${filterable ? `  ${style.muted(g.pointer)} ${filter}${style.accent('▏')}${filter ? '' : style.muted(' type to filter')}` : ''}`
        const lines = [head]
        if (offset > 0) lines.push(`${rail}   ${style.muted(`${g.up} ${offset} more`)}`)
        shown.forEach((x, i) => {
          const on = offset + i === cursor
          lines.push(`${rail} ${on ? style.accent(g.dot) : style.muted(g.hollow)} ${on ? style.bold(x.label) : x.label}${x.hint ? `  ${style.muted(x.hint)}` : ''}`)
        })
        if (!items.length) lines.push(`${rail}   ${style.muted(`nothing matches “${filter}”`)}`)
        const below = items.length - offset - shown.length
        if (below > 0) lines.push(`${rail}   ${style.muted(`${g.down} ${below} more`)}`)
        lines.push(`${rail}   ${style.muted(`${g.up}${g.down} move · enter select${filterable ? ' · type to filter' : ''}${o.back ? ' · esc back' : ' · ctrl-c cancel'}`)}`)
        return lines
      },
      key(k) {
        const items = list()
        if (k === 'up') cursor = items.length ? (cursor - 1 + items.length) % items.length : 0
        else if (k === 'down' || k === 'tab') cursor = items.length ? (cursor + 1) % items.length : 0
        else if (k === 'enter' && items[cursor]) return { value: items[cursor].value, final: answered(o.message, items[cursor].label) }
        else if (filterable && k === 'backspace') filter = filter.slice(0, -1)
        else if (k === 'escape' && filter) filter = ''
        else if (k === 'escape' && o.back) return { value: /** @type {any} */ (BACK), final: [] }
        else if (filterable && (k === 'space' || typeof k === 'object')) {
          filter += k === 'space' ? ' ' : k.char
          cursor = 0
          offset = 0
        }
      },
      cancelled: cancelled(o.message)
    }))
  }

  return {
    /**
     * One option. With more than 7 options, typing filters the list (label and hint).
     * @template T
     * @param {{ message: string, options: Array<{ label: string, value: T, hint?: string }>, initial?: number, maxVisible?: number }} o
     * @returns {Promise<T>}
     */
    select(o) {
      return /** @type {Promise<T>} */ (choose({ ...o, back: false }))
    },

    /**
     * `select` for the session's screens: Esc on an empty filter resolves to `BACK` and the picker disappears.
     * @template T
     * @param {{ message: string, options: Array<{ label: string, value: T, hint?: string }>, initial?: number, maxVisible?: number }} o
     * @returns {Promise<T | typeof BACK>}
     */
    pick(o) {
      return choose({ ...o, back: true })
    },

    /**
     * Several options: space toggles, enter confirms.
     * @template T
     * @param {{ message: string, options: Array<{ label: string, value: T, hint?: string }>, initial?: T[] }} o
     * @returns {Promise<T[]>}
     */
    multiselect(o) {
      const on = new Set(o.options.map((x, i) => (o.initial ? o.initial.includes(x.value) : true) ? i : -1).filter((i) => i >= 0))
      let cursor = 0
      const labels = () => o.options.filter((_, i) => on.has(i)).map((x) => x.label)
      return interact(ui, {
        view: () => [
          active(o.message),
          ...o.options.map((x, i) => `${rail} ${i === cursor ? style.accent(g.pointer) : ' '} ${on.has(i) ? style.ok(g.dot) : style.muted(g.hollow)} ${i === cursor ? style.bold(x.label) : x.label}${x.hint ? `  ${style.muted(x.hint)}` : ''}`),
          `${rail}   ${style.muted(`${g.up}${g.down} move · space toggle · enter confirm`)}`
        ],
        key(k) {
          if (k === 'up') cursor = (cursor - 1 + o.options.length) % o.options.length
          else if (k === 'down' || k === 'tab') cursor = (cursor + 1) % o.options.length
          else if (k === 'space') on.has(cursor) ? on.delete(cursor) : on.add(cursor)
          else if (k === 'enter') return { value: o.options.filter((_, i) => on.has(i)).map((x) => x.value), final: answered(o.message, labels().join(', ') || 'none') }
        },
        cancelled: cancelled(o.message)
      })
    },

    /** @param {{ message: string, initial?: boolean }} o @returns {Promise<boolean>} */
    confirm(o) {
      let yes = o.initial ?? true
      return interact(ui, {
        view: () => [`${active(o.message)}  ${yes ? `${style.accent(g.dot)} ${style.bold('Yes')}` : `${style.muted(g.hollow)} Yes`}  ${!yes ? `${style.accent(g.dot)} ${style.bold('No')}` : `${style.muted(g.hollow)} No`}`],
        key(k) {
          if (k === 'left' || k === 'right' || k === 'tab' || k === 'up' || k === 'down') yes = !yes
          else if (typeof k === 'object' && /^[yn]$/i.test(k.char)) return { value: /y/i.test(k.char), final: answered(o.message, /y/i.test(k.char) ? 'Yes' : 'No') }
          else if (k === 'enter') return { value: yes, final: answered(o.message, yes ? 'Yes' : 'No') }
        },
        cancelled: cancelled(o.message)
      })
    },

    /** @param {{ message: string, placeholder?: string, initial?: string, validate?: (v: string) => string | undefined }} o @returns {Promise<string>} */
    text(o) {
      let value = o.initial ?? ''
      /** @type {string | undefined} */
      let error
      return interact(ui, {
        view: () => [`${active(o.message)}  ${value || style.muted(o.placeholder ?? '')}${style.accent('▏')}`, ...(error ? [`${rail}   ${style.fail(error)}`] : [])],
        key(k) {
          error = undefined
          if (k === 'enter') {
            error = o.validate?.(value.trim())
            if (!error) return { value: value.trim(), final: answered(o.message, value.trim()) }
          } else if (k === 'backspace') value = value.slice(0, -1)
          else if (k === 'space') value += ' '
          else if (typeof k === 'object') value += k.char
        },
        cancelled: cancelled(o.message)
      })
    },

    /**
     * The interactive session's command line, in the style of Claude Code. `/` opens the command palette (filtered as
     * you type; ↑↓ move, tab completes, enter runs the highlighted command). Other text shows up to four search
     * matches (↓ picks one and enter opens it); otherwise enter sends the text on (to the KaDeep agent). ↑↓ on a line
     * with no palette or matches walk the history, shift+tab calls `onShiftTab` (the agent mode), Ctrl-C clears the
     * line and, pressed twice on an empty line, exits, as does Ctrl-D.
     * @param {CommandLineOptions} o
     * @returns {Promise<CommandLineResult>}
     */
    command(o) {
      /** @type {string[]} */
      let chars = []
      let pos = 0
      let sel = 0
      let pick = -1
      let hist = -1
      let draft = ''
      let armedExit = 0
      const history = o.history ?? []
      const value = () => chars.join('')
      /** @param {string} v */
      const set = (v) => {
        chars = [...v]
        pos = chars.length
      }
      const edited = () => {
        sel = 0
        pick = -1
        hist = -1
      }
      const palette = () => {
        const v = value()
        if (!v.startsWith('/') || /\s/.test(v)) return []
        const q = v.slice(1).toLowerCase()
        const starts = o.palette.filter((c) => c.name.startsWith(q)).sort((a, b) => Number(b.name === q) - Number(a.name === q))
        return [...starts, ...o.palette.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.summary.toLowerCase().includes(q)))]
      }
      /** @type {{ key: string, rows: SearchMatch[] }} */
      let cache = { key: '', rows: [] }
      const matches = () => {
        const v = value().trim()
        if (!o.search || v.startsWith('/') || [...v].length < 2) return []
        if (cache.key !== v) cache = { key: v, rows: o.search(v).slice(0, 4) }
        return cache.rows
      }
      /** What stays in the transcript: the line as typed, word-wrapped (never cut). @param {string} text */
      const echo = (text) => wrap(text, Math.max(20, ui.term.stdout.columns || ui.term.columns) - 1, { first: `${style.muted(g.pointer)} `, indent: '  ' })
      /** @param {CommandLineResult & { text: string }} r */
      const done = (r) => {
        if (r.text && history[history.length - 1] !== r.text) history.push(r.text)
        return { value: r, final: echo(r.text) }
      }
      const exit = () => ({ value: /** @type {CommandLineResult} */ ({ kind: 'exit' }), final: [] })

      return /** @type {Promise<CommandLineResult>} */ (interact(ui, {
        ownCtrlC: true,
        view() {
          const cols = Math.max(20, ui.term.stdout.columns || ui.term.columns) - 1
          const v = value()
          const room = cols - 4
          const before = chars.slice(0, pos).join('')
          const shownBefore = width(before) + 1 > room ? `…${tail(before, room - 2)}` : before
          const input = v ? `${shownBefore}${cursorCell(chars[pos] ?? ' ')}${chars.slice(pos + 1).join('')}` : `${cursorCell(' ')}${style.muted(o.placeholder ?? '')}`
          const lines = [`${style.accent(g.pointer)} ${input}`]
          const pal = palette()
          if (pal.length) {
            sel = Math.min(sel, pal.length - 1)
            const nameW = Math.min(16, Math.max(...pal.map((c) => c.name.length)) + 2)
            const start = Math.max(0, Math.min(sel - 2, pal.length - 6))
            pal.slice(start, start + 6).forEach((c, i) => {
              const on = start + i === sel
              lines.push(`  ${on ? style.accent(g.dot) : style.muted(g.hollow)} ${on ? style.bold(`/${c.name}`.padEnd(nameW)) : `/${c.name}`.padEnd(nameW)} ${style.muted(c.summary)}`)
            })
            if (pal.length > 6) lines.push(`    ${style.muted(`${pal.length} commands · ${g.up}${g.down} move`)}`)
            lines.push(`    ${style.muted(`${g.up}${g.down} move · tab complete · enter run · esc clear`)}`)
          } else if (v.startsWith('/')) {
            const name = v.slice(1).split(/\s+/)[0]
            const c = o.palette.find((x) => x.name === name)
            lines.push(`    ${style.muted(c ? c.usage ?? c.summary : `No command /${name} · esc clears · / lists them`)}`)
          } else {
            const m = matches()
            m.forEach((x, i) => lines.push(`  ${pick === i ? style.accent(g.dot) : style.muted(g.hollow)} ${style.muted(x.kind.padEnd(6))} ${pick === i ? style.bold(x.label) : x.label}${x.hint ? `  ${style.muted(x.hint)}` : ''}`))
            if (m.length) lines.push(`    ${style.muted(pick < 0 ? `${g.down} open a match · enter asks the agent` : `enter opens it · ${g.up} back to your text`)}`)
          }
          const footer = armedExit ? style.warn('Press Ctrl-C again to exit') : o.footer?.() ?? ''
          if (footer) lines.push(`  ${footer}`)
          return lines
        },
        key(k) {
          const v = value()
          if (k !== 'ctrl-c') armedExit = 0
          if (k === 'ctrl-c') {
            if (v) {
              set('')
              edited()
              return
            }
            if (armedExit && Date.now() - armedExit < 2500) return exit()
            armedExit = Date.now()
            return
          }
          if (k === 'ctrl-d') {
            if (!v) return exit()
            chars.splice(pos, 1)
            return
          }
          if (k === 'shift-tab') return void o.onShiftTab?.()
          const pal = palette()
          const m = matches()
          if (k === 'up') {
            if (pal.length) sel = (sel - 1 + pal.length) % pal.length
            else if (pick >= 0) pick--
            else if (hist < history.length - 1) {
              if (hist === -1) draft = v
              hist++
              set(history[history.length - 1 - hist])
            }
            return
          }
          if (k === 'down') {
            if (pal.length) sel = (sel + 1) % pal.length
            else if (hist >= 0) {
              hist--
              set(hist === -1 ? draft : history[history.length - 1 - hist])
            } else if (m.length) pick = Math.min(pick + 1, m.length - 1)
            return
          }
          if (k === 'tab') {
            if (pal.length) {
              set(`/${pal[Math.min(sel, pal.length - 1)].name} `)
              edited()
            } else if (m.length) pick = (pick + 1) % m.length
            return
          }
          if (k === 'enter') {
            if (pal.length) return done({ kind: 'command', text: `/${pal[Math.min(sel, pal.length - 1)].name}` })
            if (pick >= 0 && m[pick]) return { value: { kind: 'open', value: m[pick].value, label: m[pick].label }, final: [`${style.muted(g.pointer)} ${style.muted(m[pick].kind)} ${m[pick].label}`] }
            const t = v.trim()
            if (!t) return
            return done({ kind: t.startsWith('/') ? 'command' : 'text', text: t })
          }
          if (k === 'escape') {
            if (pick >= 0) pick = -1
            else {
              set('')
              edited()
            }
            return
          }
          if (k === 'left') pos = Math.max(0, pos - 1)
          else if (k === 'right') pos = Math.min(chars.length, pos + 1)
          else if (k === 'home' || k === 'ctrl-a') pos = 0
          else if (k === 'end' || k === 'ctrl-e') pos = chars.length
          else {
            if (k === 'backspace') {
              if (pos > 0) chars.splice(--pos, 1)
            } else if (k === 'delete') chars.splice(pos, 1)
            else if (k === 'ctrl-u') {
              chars.splice(0, pos)
              pos = 0
            } else if (k === 'ctrl-w') {
              let at = pos
              while (at > 0 && chars[at - 1] === ' ') at--
              while (at > 0 && chars[at - 1] !== ' ') at--
              chars.splice(at, pos - at)
              pos = at
            } else if (k === 'space' || typeof k === 'object') chars.splice(pos++, 0, k === 'space' ? ' ' : k.char)
            else return
            edited()
          }
        },
        cancelled: () => []
      }))
    },

    /** Input shown as dots, never echoed. @param {{ message: string }} o @returns {Promise<string>} */
    password(o) {
      let value = ''
      const mask = () => (g.dot === '●' ? '•' : '*').repeat([...value].length)
      return interact(ui, {
        view: () => [`${active(o.message)}  ${mask()}${style.accent('▏')}`],
        key(k) {
          if (k === 'enter' && value) return { value, final: answered(o.message, mask()) }
          if (k === 'backspace') value = [...value].slice(0, -1).join('')
          else if (k === 'space') value += ' '
          else if (typeof k === 'object') value += k.char
        },
        cancelled: cancelled(o.message)
      })
    }
  }
}
