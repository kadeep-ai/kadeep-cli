// @ts-check
import { readFileSync } from 'node:fs'

/** @type {string} */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

/**
 * Exit codes, a superset of the teststudios CLI's: scripts and agents branch on these.
 *   0 ok · 1 tests or gate failed · 2 usage, auth or not found · 3 KaDeep unreachable or server error · 4 not ready yet
 */
export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, NETWORK: 3, NOT_READY: 4 })

/**
 * Every expected failure is a KadeepError: `code` is stable for agents (`--json` prints it), `exitCode` is what the
 * process ends with.
 */
export class KadeepError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, exitCode?: number, status?: number, details?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'KadeepError'
    this.code = opts.code ?? 'error'
    this.exitCode = opts.exitCode ?? EXIT.FAILED
    this.status = opts.status
    this.details = opts.details
  }
}

/** @param {string} message */
export const usage = (message) => new KadeepError(message, { code: 'usage', exitCode: EXIT.USAGE })
