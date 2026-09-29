// @ts-check
import { createStyle } from './style.mjs'
import { glyphs } from './symbols.mjs'
import { detectTerm } from './term.mjs'

/**
 * KaDeep's terminal UI, with no dependencies. `createUi()` decides the mode (rich / plain / json), colors and glyphs
 * once; everything else draws with them. releasegate uses the same layer through `import { ui } from 'kadeep'`.
 *
 * @typedef {{ term: import('./term.mjs').Term, style: import('./style.mjs').Style, g: import('./symbols.mjs').Glyphs, rich: boolean }} UiContext
 */

/**
 * @param {{ json?: boolean, noColor?: boolean, accent?: 'testing' | 'loc', env?: NodeJS.ProcessEnv, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream }} [opts]
 * @returns {UiContext}
 */
export function createUi(opts = {}) {
  const term = detectTerm(opts)
  return { term, style: createStyle(term.color, { accent: opts.accent }), g: glyphs(term.unicode), rich: term.mode === 'rich' }
}

export { detectTerm } from './term.mjs'
export { createStyle, strip, width, truncate, pad } from './style.mjs'
export { glyphs, pulse, clock } from './symbols.mjs'
export { createLive } from './live.mjs'
export { header, markLines, KS_MARK, MARK_WIDTH } from './logo.mjs'
export { bigText } from './dotfont.mjs'
export { dotStrip } from './dots.mjs'
export { box } from './box.mjs'
export { createPrompts, parseKeys } from './prompts.mjs'
export { dotFill } from './animate.mjs'
export { withSpinner } from './spinner.mjs'
