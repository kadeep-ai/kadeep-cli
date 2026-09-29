// @ts-check

/**
 * The KaDeep Studios palette in the terminal, from the site's design tokens (no colors of our own):
 * testing blue #3b82f6 is the accent, localization orange #E8590C replaces it in `kadeep loc`, and status uses
 * green / red / yellow. Each color degrades from truecolor to 256 and 16 colors, and to nothing.
 *
 * @typedef {(s: unknown) => string} Paint
 * @typedef {{ level: number, accent: Paint, loc: Paint, ok: Paint, fail: Paint, warn: Paint, dim: Paint, bold: Paint, muted: Paint, plain: Paint }} Style
 */

/** @type {Record<string, { rgb: [number, number, number], c256: number, c16: number }>} */
const PALETTE = {
  testing: { rgb: [59, 130, 246], c256: 69, c16: 94 },
  loc: { rgb: [232, 89, 12], c256: 202, c16: 33 },
  ok: { rgb: [34, 197, 94], c256: 41, c16: 32 },
  fail: { rgb: [239, 68, 68], c256: 203, c16: 31 },
  warn: { rgb: [234, 179, 8], c256: 178, c16: 33 },
  muted: { rgb: [113, 113, 122], c256: 243, c16: 90 }
}

/** @param {number} level @param {keyof typeof PALETTE} name @returns {Paint} */
function fg(level, name) {
  const c = PALETTE[name]
  const open = level >= 3 ? `\u001b[38;2;${c.rgb.join(';')}m` : level === 2 ? `\u001b[38;5;${c.c256}m` : `\u001b[${c.c16}m`
  return (s) => `${open}${s}\u001b[39m`
}

/**
 * @param {number} level 0 none · 1 16 colors · 2 256 · 3 truecolor
 * @param {{ accent?: 'testing' | 'loc' }} [opts]
 * @returns {Style}
 */
export function createStyle(level, opts = {}) {
  const same = /** @type {Paint} */ ((s) => String(s))
  if (!level) return { level: 0, accent: same, loc: same, ok: same, fail: same, warn: same, dim: same, bold: same, muted: same, plain: same }
  return {
    level,
    accent: fg(level, opts.accent === 'loc' ? 'loc' : 'testing'),
    loc: fg(level, 'loc'),
    ok: fg(level, 'ok'),
    fail: fg(level, 'fail'),
    warn: fg(level, 'warn'),
    muted: fg(level, 'muted'),
    dim: (s) => `\u001b[2m${s}\u001b[22m`,
    bold: (s) => `\u001b[1m${s}\u001b[22m`,
    plain: same
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

/** Remove color and cursor escape sequences. @param {string} s */
export const strip = (s) => s.replace(ANSI, '')

/** @param {number} cp */
function cpWidth(cp) {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

/** Columns a string takes on screen (escape sequences ignored, wide characters count 2). @param {string} s */
export function width(s) {
  let w = 0
  for (const ch of strip(s)) w += cpWidth(/** @type {number} */ (ch.codePointAt(0)))
  return w
}

/**
 * Cut a string to `max` columns, ending in `…`. Escape sequences are kept, so styled text stays styled.
 * @param {string} s
 * @param {number} max
 */
export function truncate(s, max) {
  if (width(s) <= max) return s
  if (max <= 1) return max === 1 ? '…' : ''
  let out = ''
  let w = 0
  let i = 0
  const src = s
  while (i < src.length) {
    ANSI.lastIndex = i
    const m = ANSI.exec(src)
    if (m && m.index === i) {
      out += m[0]
      i += m[0].length
      continue
    }
    const cp = /** @type {number} */ (src.codePointAt(i))
    const ch = String.fromCodePoint(cp)
    const cw = cpWidth(cp)
    if (w + cw > max - 1) break
    out += ch
    w += cw
    i += ch.length
  }
  // Close any color left open by the cut.
  return strip(s) === s ? `${out}…` : `${out}…\u001b[0m`
}

/** Pad to `n` columns by display width. @param {string} s @param {number} n */
export const pad = (s, n) => s + ' '.repeat(Math.max(0, n - width(s)))

/**
 * Word-wrap plain text to `max` columns by display width, so long lines never break mid-word the way a terminal
 * wraps them. Line breaks in the text are kept; a word longer than a line (a URL) is cut; past `maxLines` the last
 * line ends in `…`. Wrap the plain text first, then style each line.
 * @param {string} text
 * @param {number} max  columns, including the indent
 * @param {{ indent?: string, first?: string, maxLines?: number }} [opts]  `first` replaces `indent` on the first line (a hanging indent)
 * @returns {string[]}
 */
export function wrap(text, max, opts = {}) {
  const indent = opts.indent ?? ''
  const first = opts.first ?? indent
  /** @type {string[]} */
  const lines = []
  for (const para of strip(String(text ?? '')).replace(/\r\n?/g, '\n').split('\n')) {
    let lead = lines.length ? indent : first
    let room = Math.max(1, max - width(lead))
    let line = ''
    const flush = () => {
      lines.push(`${lead}${line}`.trimEnd())
      line = ''
      lead = indent
      room = Math.max(1, max - width(lead))
    }
    for (const word of para.split(/[ \t]+/).filter(Boolean)) {
      const w = width(word)
      if (line && width(line) + 1 + w <= room) {
        line += ` ${word}`
        continue
      }
      if (line) flush()
      if (w <= room) {
        line = word
        continue
      }
      // Longer than a whole line: cut it into line-sized pieces.
      let piece = ''
      for (const ch of word) {
        if (width(piece + ch) > room) {
          line = piece
          flush()
          piece = ''
        }
        piece += ch
      }
      line = piece
    }
    flush()
  }
  if (opts.maxLines && lines.length > opts.maxLines) {
    const kept = lines.slice(0, opts.maxLines)
    const last = kept[kept.length - 1]
    kept[kept.length - 1] = width(last) + 1 <= max ? `${last}…` : truncate(last, max)
    return kept
  }
  return lines
}
