// @ts-check
import { ciContext } from '../ci-env.mjs'

/**
 * What the terminal can do, decided once per process.
 *
 *   rich   stdout and stderr are terminals, not CI: live regions, dots, prompts, boxes, animation
 *   plain  piped or redirected output, CI, TERM=dumb, KADEEP_UI=plain: one line per real change, no cursor movement
 *   json   --json: nothing but the one JSON document on stdout
 *
 * KADEEP_UI=rich forces rich output (recordings, tests); KADEEP_UI=plain forces plain.
 *
 * @typedef {'rich' | 'plain' | 'json'} Mode
 * @typedef {0 | 1 | 2 | 3} ColorLevel none · 16 colors · 256 colors · truecolor
 * @typedef {{
 *   mode: Mode,
 *   color: ColorLevel,
 *   unicode: boolean,
 *   ci: boolean,
 *   interactive: boolean,
 *   columns: number,
 *   env: NodeJS.ProcessEnv,
 *   stdout: NodeJS.WriteStream,
 *   stderr: NodeJS.WriteStream,
 *   stdin: NodeJS.ReadStream,
 *   session?: Session
 * }} Term
 * @typedef {{ keys: import('./keys.mjs').Keys, lives: Set<{ stop: (o?: { keep?: boolean }) => void }>, signal?: AbortSignal }} Session
 *   Set inside the interactive session: keys come from the session's input hub, live regions register so an
 *   interrupted command can be cleared, and `signal` aborts when the user interrupts the command.
 */

/** @param {NodeJS.ProcessEnv} env */
const noColorEnv = (env) => typeof env.NO_COLOR === 'string' && env.NO_COLOR !== ''

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.WriteStream} stream
 * @param {Mode} mode
 * @param {boolean} flagNoColor
 * @returns {ColorLevel}
 */
function colorLevel(env, stream, mode, flagNoColor) {
  if (flagNoColor || noColorEnv(env) || mode === 'json') return 0
  const force = env.FORCE_COLOR
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0
    if (force === '2') return 2
    if (force === '3') return 3
    return 1
  }
  if (mode !== 'rich' || env.TERM === 'dumb') return 0
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') return 3
  const depth = typeof stream.getColorDepth === 'function' ? stream.getColorDepth(env) : 4
  return depth >= 24 ? 3 : depth >= 8 ? 2 : depth >= 4 ? 1 : 0
}

/** Unicode glyphs everywhere except the legacy Windows console and the Linux text console. @param {NodeJS.ProcessEnv} env */
function unicodeOk(env) {
  if (process.platform !== 'win32') return env.TERM !== 'linux'
  return Boolean(env.WT_SESSION || env.TERMINUS_SUBLIME || env.ConEmuTask === '{cmd::Cmder}' || env.TERM_PROGRAM === 'vscode' || env.TERM === 'xterm-256color' || env.TERM === 'alacritty')
}

/**
 * @param {{ env?: NodeJS.ProcessEnv, stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream, stdin?: NodeJS.ReadStream, json?: boolean, noColor?: boolean, session?: Session }} [opts]
 * @returns {Term}
 */
export function detectTerm(opts = {}) {
  const env = opts.env ?? process.env
  const stdout = opts.stdout ?? process.stdout
  const stderr = opts.stderr ?? process.stderr
  const stdin = opts.stdin ?? process.stdin
  const ci = ciContext(env, { git: false }).ci
  const forced = env.KADEEP_UI
  /** @type {Mode} */
  const mode = opts.json ? 'json' : forced === 'rich' ? 'rich' : forced === 'plain' || ci || env.TERM === 'dumb' ? 'plain' : stdout.isTTY && stderr.isTTY ? 'rich' : 'plain'
  return {
    mode,
    color: colorLevel(env, stdout, mode, Boolean(opts.noColor)),
    unicode: unicodeOk(env),
    ci,
    interactive: mode === 'rich' && Boolean(stdin.isTTY),
    columns: Math.max(20, stdout.columns || stderr.columns || 80),
    env,
    stdout,
    stderr,
    stdin,
    ...(opts.session ? { session: opts.session } : {})
  }
}
