// @ts-check

/**
 * Glyphs, with ASCII fallbacks for terminals without the unicode ones. The dot is KaDeep's visual signature: the logo
 * is a grid of dots, so progress, bullets and the spinner are dots too.
 * @typedef {ReturnType<typeof glyphs>} Glyphs
 */

/** @param {boolean} unicode */
export function glyphs(unicode) {
  return unicode
    ? { dot: '●', hollow: '○', small: '∙', ok: '✔', fail: '✖', warn: '▲', pointer: '›', ellipsis: '…', up: '↑', down: '↓', rule: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯', bullet: '·' }
    : { dot: '*', hollow: 'o', small: '.', ok: 'v', fail: 'x', warn: '!', pointer: '>', ellipsis: '...', up: '^', down: 'v', rule: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+', bullet: '-' }
}

/** The dot-pulse spinner: a dot travelling along three places and back. @param {Glyphs} g */
export const pulse = (g) => [`${g.dot} ${g.small} ${g.small}`, `${g.small} ${g.dot} ${g.small}`, `${g.small} ${g.small} ${g.dot}`, `${g.small} ${g.dot} ${g.small}`]

/** m:ss for live timers. @param {number} ms */
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
