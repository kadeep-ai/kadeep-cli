// @ts-check
import { EXIT, KadeepError } from '../errors.mjs'
import { truncate } from './style.mjs'

/**
 * Arrow-key prompts drawn on stderr: select (type to filter), multiselect, confirm, text and a masked password.
 * The active step is a hollow accent dot, an answered step a solid green one. Ctrl-C restores the terminal and
 * rejects with a `cancelled` error (exit 130). Needs an interactive terminal; commands check `term.interactive` and
 * fall back to flags (or plain line prompts) otherwise.
 *
 * @typedef {{ term: import('./term.mjs').Term, style: import('./style.mjs').Style, g: import('./symbols.mjs').Glyphs }} Ui
 * @typedef {{ label: string, value: unknown, hint?: string }} Option
 * @typedef {'up' | 'down' | 'left' | 'right' | 'enter' | 'backspace' | 'escape' | 'tab' | 'space' | 'ctrl-c' | 'ctrl-d' | { char: string }} Key
 */

const HIDE = '\u001b[?25l'
const SHOW = '\u001b[?25h'

/** Raw terminal input → key names (one chunk can hold several keys, e.g. a paste). @param {string} chunk @returns {Key[]} */
export function parseKeys(chunk) {
  /** @type {Key[]} */
  const out = []
  let i = 0
  while (i < chunk.length) {
    const rest = chunk.slice(i)
    const arrow = /^\u001b[[O]([ABCD])/.exec(rest)
    if (arrow) {
      out.push(/** @type {Key} */ ({ A: 'up', B: 'down', C: 'right', D: 'left' }[arrow[1]]))
      i += arrow[0].length
      continue
    }
    const seq = /^\u001b\[[0-9;]*~/.exec(rest)
    if (seq) {
      i += seq[0].length
      continue
    }
    const cp = /** @type {number} */ (rest.codePointAt(0))
    const ch = String.fromCodePoint(cp)
    if (ch === '\r' || ch === '\n') out.push('enter')
    else if (ch === '\u0003') out.push('ctrl-c')
    else if (ch === '\u0004') out.push('ctrl-d')
    else if (ch === '\u007f' || ch === '\b') out.push('backspace')
    else if (ch === '\u001b') out.push('escape')
    else if (ch === '\t') out.push('tab')
    else if (ch === ' ') out.push('space')
    else if (cp >= 0x20) out.push({ char: ch })
    i += ch.length
  }
  return out
}

/**
 * The shared loop: draw, read keys, redraw, finish with the answered line.
 * @template T
 * @param {Ui} ui
 * @param {{ view: () => string[], key: (k: Key) => { value: T, final: string[] } | void, cancelled: () => string[] }} spec
 * @returns {Promise<T>}
 */
function interact(ui, spec) {
  const { stdin, stderr } = ui.term
  if (!ui.term.interactive || typeof stdin.setRawMode !== 'function') return Promise.reject(new KadeepError('This prompt needs an interactive terminal; pass the value as a flag instead.', { code: 'usage', exitCode: EXIT.USAGE }))
  let rendered = 0
  const cols = () => Math.max(20, ui.term.stdout.columns || ui.term.columns) - 1
  /** @param {string[]} lines */
  const draw = (lines) => {
    stderr.write(`${rendered ? `\u001b[${rendered}F\u001b[J` : ''}${lines.map((l) => truncate(l, cols())).join('\n')}\n`)
    rendered = lines.length
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      stderr.write(SHOW)
      process.off('exit', restore)
    }
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
      for (const k of parseKeys(String(chunk))) {
        if (k === 'ctrl-c' || k === 'ctrl-d') {
          draw(spec.cancelled())
          cleanup()
          return reject(new KadeepError('Cancelled', { code: 'cancelled', exitCode: 130 }))
        }
        const done = spec.key(k)
        if (done) {
          draw(done.final)
          cleanup()
          return resolve(done.value)
        }
      }
      draw(spec.view())
    }
    process.once('exit', restore)
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
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

  return {
    /**
     * One option. With more than 7 options, typing filters the list (label and hint).
     * @template T
     * @param {{ message: string, options: Array<{ label: string, value: T, hint?: string }>, initial?: number, maxVisible?: number }} o
     * @returns {Promise<T>}
     */
    select(o) {
      const filterable = o.options.length > 7
      const max = o.maxVisible ?? 8
      let filter = ''
      let cursor = Math.max(0, Math.min(o.initial ?? 0, o.options.length - 1))
      let offset = 0
      const list = () => (filter ? o.options.filter((x) => `${x.label} ${x.hint ?? ''}`.toLowerCase().includes(filter.toLowerCase())) : o.options)
      return interact(ui, {
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
          lines.push(`${rail}   ${style.muted(`${g.up}${g.down} move · enter select${filterable ? ' · type to filter' : ''} · ctrl-c cancel`)}`)
          return lines
        },
        key(k) {
          const items = list()
          if (k === 'up') cursor = items.length ? (cursor - 1 + items.length) % items.length : 0
          else if (k === 'down' || k === 'tab') cursor = items.length ? (cursor + 1) % items.length : 0
          else if (k === 'enter' && items[cursor]) return { value: items[cursor].value, final: answered(o.message, items[cursor].label) }
          else if (filterable && k === 'backspace') filter = filter.slice(0, -1)
          else if (filterable && k === 'escape') filter = ''
          else if (filterable && (k === 'space' || typeof k === 'object')) {
            filter += k === 'space' ? ' ' : k.char
            cursor = 0
            offset = 0
          }
        },
        cancelled: cancelled(o.message)
      })
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
