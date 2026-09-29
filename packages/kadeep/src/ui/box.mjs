// @ts-check
import { pad, truncate, width } from './style.mjs'

/**
 * A rounded box around lines, as wide as its content (at most the terminal), with an optional title in the top
 * border: `╭─ CI token · shown once ──╮`. `border` colors the frame (green for a pass, red for a failure).
 * @param {string[]} lines
 * @param {{ columns: number, g: import('./symbols.mjs').Glyphs, title?: string, border?: (s: string) => string }} opts
 */
export function box(lines, opts) {
  const { g } = opts
  const paint = opts.border ?? ((s) => s)
  const titleW = opts.title ? width(opts.title) + 1 : 0
  const inner = Math.max(4, Math.min(Math.max(titleW, ...lines.map(width)), opts.columns - 4))
  const top = opts.title
    ? `${g.tl}${g.rule} ${truncate(opts.title, inner - 1)} ${g.rule.repeat(Math.max(0, inner - 1 - width(truncate(opts.title, inner - 1))))}${g.tr}`
    : `${g.tl}${g.rule.repeat(inner + 2)}${g.tr}`
  return [paint(top), ...lines.map((l) => `${paint(g.v)} ${pad(truncate(l, inner), inner)} ${paint(g.v)}`), paint(`${g.bl}${g.rule.repeat(inner + 2)}${g.br}`)]
}
