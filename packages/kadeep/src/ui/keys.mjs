// @ts-check

/**
 * Keyboard input. `parseKeys` turns raw terminal bytes into key names; `createKeys` is the interactive session's one
 * owner of stdin: stdin stays in raw mode while any handler is registered, and each key goes only to the newest
 * handler (the prompt, a picker, or the "esc to interrupt" listener of a running command).
 *
 * @typedef {'up' | 'down' | 'left' | 'right' | 'home' | 'end' | 'delete' | 'enter' | 'backspace' | 'escape' | 'tab' | 'shift-tab' | 'space'
 *   | 'ctrl-a' | 'ctrl-c' | 'ctrl-d' | 'ctrl-e' | 'ctrl-l' | 'ctrl-u' | 'ctrl-w' | { char: string }} Key
 * @typedef {(key: Key) => void} KeyHandler
 * @typedef {ReturnType<typeof createKeys>} Keys
 */

/** @type {Record<string, Key>} */
const CSI = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shift-tab' }
/** @type {Record<string, Key>} */
const TILDE = { 1: 'home', 3: 'delete', 4: 'end', 7: 'home', 8: 'end' }
/** @type {Record<string, Key>} */
const CTRL = { '\u0001': 'ctrl-a', '\u0003': 'ctrl-c', '\u0004': 'ctrl-d', '\u0005': 'ctrl-e', '\u000c': 'ctrl-l', '\u0015': 'ctrl-u', '\u0017': 'ctrl-w' }

/** Raw terminal input → key names (one chunk can hold several keys, e.g. a paste). @param {string} chunk @returns {Key[]} */
export function parseKeys(chunk) {
  /** @type {Key[]} */
  const out = []
  let i = 0
  while (i < chunk.length) {
    const rest = chunk.slice(i)
    const csi = /^\u001b[[O]([ABCDHFZ])/.exec(rest)
    if (csi) {
      out.push(CSI[csi[1]])
      i += csi[0].length
      continue
    }
    const seq = /^\u001b\[([0-9;]*)~/.exec(rest)
    if (seq) {
      if (TILDE[seq[1]]) out.push(TILDE[seq[1]])
      i += seq[0].length
      continue
    }
    const cp = /** @type {number} */ (rest.codePointAt(0))
    const ch = String.fromCodePoint(cp)
    if (ch === '\r' || ch === '\n') out.push('enter')
    else if (CTRL[ch]) out.push(CTRL[ch])
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
 * @param {NodeJS.ReadStream} stdin
 */
export function createKeys(stdin) {
  /** @type {KeyHandler[]} */
  const stack = []
  let listening = false

  /** @param {string | Buffer} chunk */
  const onData = (chunk) => {
    for (const k of parseKeys(String(chunk))) stack[stack.length - 1]?.(k)
  }
  const restore = () => {
    try {
      stdin.setRawMode?.(false)
    } catch {
      /* already closed */
    }
  }

  function listen() {
    if (listening) return
    listening = true
    stdin.setRawMode?.(true)
    stdin.setEncoding('utf8')
    stdin.resume()
    stdin.on('data', onData)
    process.once('exit', restore)
  }

  function quiet() {
    if (!listening) return
    listening = false
    stdin.off('data', onData)
    restore()
    stdin.pause()
    process.off('exit', restore)
  }

  return {
    /** Send keys to `handler` until the returned function is called. @param {KeyHandler} handler @returns {() => void} */
    push(handler) {
      stack.push(handler)
      listen()
      return () => {
        const at = stack.lastIndexOf(handler)
        if (at >= 0) stack.splice(at, 1)
        if (!stack.length) quiet()
      }
    },
    /** Let go of stdin (raw mode off) whatever is registered. */
    close() {
      stack.length = 0
      quiet()
    },
    get depth() {
      return stack.length
    }
  }
}
