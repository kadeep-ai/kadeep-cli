// @ts-check
import { truncate, width } from '../ui/style.mjs'

/**
 * The agent's replies are markdown. In a rich terminal they are drawn line by line as they stream: headings bold,
 * bullets as `•`, `**bold**` and `code` styled, fenced code and tables kept as they are (cut to the width), and prose
 * word-wrapped to the terminal so no word is split. Plain output prints the markdown untouched.
 *
 * @typedef {import('../ui/style.mjs').Style} Style
 * @typedef {'' | 'b' | 'c'} Span  plain · bold · code
 * @typedef {Array<{ ch: string, s: Span }>} Word
 */

/** @param {string} text @returns {Word[]} words of styled characters */
function words(text) {
  /** @type {Word[]} */
  const out = []
  /** @type {Word} */
  let word = []
  // **bold**, `code`, and *emphasis* / _emphasis_ (drawn plain: the markers go, the words stay).
  const re = /\*\*([^*]+)\*\*|`([^`]+)`|(?<![\w*])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?![\w*])/g
  let last = 0
  /** @param {string} t @param {Span} s */
  const add = (t, s) => {
    for (const ch of t) {
      if (ch === ' ' || ch === '\t') {
        if (word.length) out.push(word)
        word = []
      } else word.push({ ch, s })
    }
  }
  for (let m = re.exec(text); m; m = re.exec(text)) {
    add(text.slice(last, m.index), '')
    add(m[1] ?? m[2] ?? m[3], m[1] !== undefined ? 'b' : m[2] !== undefined ? 'c' : '')
    last = m.index + m[0].length
  }
  add(text.slice(last), '')
  if (word.length) out.push(word)
  return out
}

/** @param {Word} w */
const wordWidth = (w) => width(w.map((x) => x.ch).join(''))

/** @param {Word} w @param {Style} style */
function paint(w, style) {
  let out = ''
  let run = ''
  /** @type {Span} */
  let s = ''
  const flush = () => {
    out += s === 'b' ? style.bold(run) : s === 'c' ? style.accent(run) : run
    run = ''
  }
  for (const x of w) {
    if (x.s !== s) {
      flush()
      s = x.s
    }
    run += x.ch
  }
  flush()
  return out
}

/**
 * Word-wrap styled text: widths come from the plain characters, styles are applied after the cut.
 * @param {string} text
 * @param {number} max
 * @param {{ first: string, indent: string, style: Style, base?: (s: string) => string }} o
 */
function wrapStyled(text, max, o) {
  /** @type {string[]} */
  const lines = []
  let lead = o.first
  /** @type {Word[]} */
  let line = []
  let used = 0
  const room = () => Math.max(1, max - width(lead))
  const flush = () => {
    const body = line.map((w) => paint(w, o.style)).join(' ')
    lines.push(`${lead}${o.base ? o.base(body) : body}`)
    line = []
    used = 0
    lead = o.indent
  }
  for (const w of words(text)) {
    let ww = wordWidth(w)
    if (line.length && used + 1 + ww <= room()) {
      line.push(w)
      used += 1 + ww
      continue
    }
    if (line.length) flush()
    let rest = w
    // A word longer than a line (a URL): cut it.
    while (ww > room()) {
      /** @type {Word} */
      const piece = []
      let pw = 0
      while (rest.length && (!piece.length || pw + width(rest[0].ch) <= room())) {
        pw += width(rest[0].ch)
        piece.push(/** @type {Word[number]} */ (rest.shift()))
      }
      line = [piece]
      flush()
      ww = wordWidth(rest)
    }
    line = rest.length ? [rest] : []
    used = ww
  }
  if (line.length || !lines.length) flush()
  return lines
}

/**
 * Renders complete markdown lines, one call per line, keeping state across calls (inside a code fence or not).
 * @param {Style} style
 * @param {import('../ui/symbols.mjs').Glyphs} g
 * @param {() => number} columns
 */
export function createMarkdown(style, g, columns) {
  let fence = false
  return {
    /** @param {string} raw @returns {string[]} */
    line(raw) {
      const cols = Math.max(20, columns() - 1)
      const line = raw.replace(/\s+$/, '')
      if (/^\s*```/.test(line)) {
        fence = !fence
        return fence ? [] : ['']
      }
      if (fence) return [`  ${style.muted(truncate(line, cols - 2))}`]
      if (!line.trim()) return ['']
      const h = /^(#{1,6})\s+(.*)$/.exec(line)
      if (h) return wrapStyled(h[2], cols, { first: '', indent: '', style, base: style.bold })
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return [style.muted(g.rule.repeat(Math.min(cols, 40)))]
      if (/^\s*\|.*\|\s*$/.test(line)) return /^\s*\|[\s:|-]+\|\s*$/.test(line) ? [style.muted(truncate(line.trim(), cols))] : [truncate(line.trim().replace(/\|/g, style.muted('|')), cols)]
      const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
      if (bullet) {
        const pad = ' '.repeat(Math.min(6, bullet[1].length))
        return wrapStyled(bullet[2], cols, { first: `${pad}${style.accent(g.bullet === '·' ? '•' : '-')} `, indent: `${pad}  `, style })
      }
      const num = /^(\s*)(\d+[.)])\s+(.*)$/.exec(line)
      if (num) {
        const pad = ' '.repeat(Math.min(6, num[1].length))
        return wrapStyled(num[3], cols, { first: `${pad}${style.muted(num[2])} `, indent: `${pad}${' '.repeat(num[2].length + 1)}`, style })
      }
      const quote = /^\s*>\s?(.*)$/.exec(line)
      if (quote) return wrapStyled(quote[1], cols, { first: `${style.muted(g.v)} `, indent: `${style.muted(g.v)} `, style, base: style.muted })
      return wrapStyled(line.trim(), cols, { first: '', indent: '', style })
    }
  }
}
