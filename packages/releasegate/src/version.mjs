// @ts-check
import { readFileSync } from 'node:fs'

/** @type {string} */
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
