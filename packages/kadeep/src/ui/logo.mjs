// @ts-check

/**
 * The KaDeep Studios "KS" mark: the 66 dots of `.github/assets/kadeep-studios-logo.svg` (brand/ks-logo-dark.svg) on
 * their 13 × 8 grid. Regenerate with `node scripts/gen-logo.mjs <svg>` if the logo changes.
 */
export const KS_MARK = ['##..##..#####', '##.##..######', '####...##....', '###....#####.', '###.....#####', '####.......##', '##.##..######', '##..##.#####.']

/** Columns the mark takes: 13 dots with a space between each. */
export const MARK_WIDTH = KS_MARK[0].length * 2 - 1

/** The mark's dots as [row, col] in the order the dot-fill animation lights them: left to right, top to bottom. */
export const MARK_DOTS = (() => {
  /** @type {Array<[number, number]>} */
  const dots = []
  for (let c = 0; c < KS_MARK[0].length; c++) for (let r = 0; r < KS_MARK.length; r++) if (KS_MARK[r][c] === '#') dots.push([r, c])
  return dots
})()

/**
 * The mark as text lines. `lit(row, col)` decides which dots are on (the animation lights them one by one); unlit
 * dots are drawn as faint small dots.
 * @param {import('./symbols.mjs').Glyphs} g
 * @param {import('./style.mjs').Style} style
 * @param {(row: number, col: number) => boolean} [lit]
 */
export function markLines(g, style, lit = () => true) {
  return KS_MARK.map((row, r) => [...row].map((ch, c) => (ch !== '#' ? ' ' : lit(r, c) ? style.bold(g.dot) : style.muted(g.small))).join(' '))
}

/**
 * The header: the mark with up to 8 lines of text beside it (row i of the text sits next to row i of the mark). In
 * a terminal narrower than 60 columns only the text is shown.
 * @param {import('./term.mjs').Term} term
 * @param {import('./symbols.mjs').Glyphs} g
 * @param {import('./style.mjs').Style} style
 * @param {Array<string | undefined>} text
 * @param {(row: number, col: number) => boolean} [lit]
 */
export function header(term, g, style, text, lit) {
  if (term.columns < 60) return text.filter((t) => typeof t === 'string' && t.length > 0).map(String)
  return markLines(g, style, lit).map((m, i) => (text[i] ? `${m}    ${text[i]}` : m))
}
