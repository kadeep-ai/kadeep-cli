// @ts-check
import { createInterface } from 'node:readline'
import { usage } from './errors.mjs'

/** Prompts read the terminal and write to stderr, so they never pollute stdout. */
export const interactive = () => Boolean(process.stdin.isTTY && process.stderr.isTTY)

/** @param {string} what */
const needTty = (what) => usage(`${what} needs an interactive terminal; pass it as a flag instead.`)

/**
 * @param {string} question
 * @param {{ default?: string, flag?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function ask(question, opts = {}) {
  if (!interactive()) throw needTty(opts.flag ?? question)
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await new Promise((resolve) => rl.question(`${question}${opts.default ? ` (${opts.default})` : ''}: `, resolve))
    return String(answer).trim() || opts.default || ''
  } finally {
    rl.close()
  }
}

/**
 * Read a secret without echoing it.
 * @param {string} question
 * @returns {Promise<string>}
 */
export function askHidden(question) {
  if (!interactive()) return Promise.reject(needTty('Password entry'))
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    process.stderr.write(`${question}: `)
    let value = ''
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    /** @param {string} chunk */
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') {
          done()
          return resolve(value)
        }
        if (ch === '\u0003') {
          done()
          process.stderr.write('\n')
          return reject(Object.assign(usage('Cancelled'), { exitCode: 130 }))
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    const done = () => {
      stdin.off('data', onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stderr.write('\n')
    }
    stdin.on('data', onData)
  })
}

/**
 * @param {string} question
 * @param {boolean} [def]
 */
export async function confirm(question, def = false) {
  const a = (await ask(`${question} [${def ? 'Y/n' : 'y/N'}]`)).toLowerCase()
  return a ? a === 'y' || a === 'yes' : def
}

/**
 * Pick one item from a numbered list.
 * @template T
 * @param {string} question
 * @param {T[]} items
 * @param {(item: T) => string} label
 * @param {number} [defaultIndex]
 * @returns {Promise<T>}
 */
export async function choose(question, items, label, defaultIndex = 0) {
  if (!interactive()) throw needTty(question)
  items.forEach((item, i) => process.stderr.write(`  ${String(i + 1).padStart(2)}) ${label(item)}\n`))
  for (;;) {
    const a = await ask(question, { default: String(defaultIndex + 1) })
    const n = Number(a)
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]
    process.stderr.write(`Enter a number from 1 to ${items.length}.\n`)
  }
}

/** Everything piped on stdin (for --password-stdin). */
export async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
}
