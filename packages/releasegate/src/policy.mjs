// @ts-check
import { existsSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { BROWSERS, VIEWPORTS } from 'kadeep'
import YAML from 'yaml'

/** Where the policy is looked for, in order, when --policy is not given. */
export const POLICY_FILES = ['releasegate.yml', 'releasegate.yaml', 'releasegate.json', '.releasegate.yml', '.github/releasegate.yml']

/**
 * @typedef {{ locales?: string[], minCoverage?: number, minMqm?: number, requireApproved: boolean }} LocalizationRule
 * @typedef {{ name: string, type: 'suite' | 'tests' | 'localization', required: boolean, suite?: string, tests?: string[], browser?: string, viewport?: string, timeoutMinutes: number, localization?: LocalizationRule }} Check
 * @typedef {{ file: string, version: 1, project?: string, mode: 'enforce' | 'shadow', checks: Check[], report: { dir: string, junit: boolean, markdown: boolean } }} Policy
 */

/** A policy that cannot be used, with every problem found (not just the first). */
export class PolicyError extends Error {
  /** @param {string} message @param {string[]} [problems] @param {'enforce' | 'shadow'} [mode] the mode the file asked for, if readable */
  constructor(message, problems = [], mode) {
    super(problems.length ? `${message}\n${problems.map((p) => `  - ${p}`).join('\n')}` : message)
    this.name = 'PolicyError'
    this.problems = problems
    this.mode = mode
  }
}

/** @param {string} a @param {string} b */
function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  return d[a.length][b.length]
}

/** @param {string} key @param {string[]} known */
const unknownKey = (key, known) => {
  const near = known.find((k) => distance(key.toLowerCase(), k.toLowerCase()) <= 2)
  return `unknown key "${key}"${near ? ` (did you mean "${near}"?)` : ''}`
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * The policy file to use: --policy, or the first of POLICY_FILES in `cwd`.
 * @param {string} cwd
 * @param {string} [explicit]
 */
export function findPolicy(cwd, explicit) {
  if (explicit) {
    const file = resolve(cwd, explicit)
    if (!existsSync(file)) throw new PolicyError(`Policy file not found: ${explicit}`)
    return file
  }
  for (const name of POLICY_FILES) if (existsSync(join(cwd, name))) return join(cwd, name)
  throw new PolicyError(`No releasegate policy found in ${cwd}. Create releasegate.yml (\`npx kadeep init\` writes one) or pass --policy <file>.`)
}

/** @param {string} file */
export function loadPolicy(file) {
  return parsePolicy(readFileSync(file, 'utf8'), file)
}

/**
 * Parse and validate a policy (YAML or JSON). Unknown keys are errors, so a typo cannot silently drop a check.
 * @param {string} text
 * @param {string} [file]
 * @returns {Policy}
 */
export function parsePolicy(text, file = 'releasegate.yml') {
  const shown = relative(process.cwd(), file) || file
  /** @type {unknown} */
  let raw
  try {
    raw = file.endsWith('.json') ? JSON.parse(text) : YAML.parse(text)
  } catch (err) {
    throw new PolicyError(`${shown} is not valid ${file.endsWith('.json') ? 'JSON' : 'YAML'}: ${/** @type {Error} */ (err).message.split('\n')[0]}`)
  }
  if (!isObject(raw)) throw new PolicyError(`${shown} must be a mapping with version, project, mode and checks`)
  /** @type {string[]} */
  const problems = []
  const top = ['version', 'project', 'mode', 'checks', 'report']
  for (const k of Object.keys(raw)) if (!top.includes(k)) problems.push(unknownKey(k, top))

  const version = raw.version ?? 1
  if (version !== 1) problems.push(`version must be 1 (got ${JSON.stringify(version)})`)
  const project = raw.project === undefined || raw.project === null ? undefined : String(raw.project).trim()
  if (project === '') problems.push('project is empty')
  const mode = raw.mode ?? 'enforce'
  if (mode !== 'enforce' && mode !== 'shadow') problems.push(`mode must be enforce or shadow (got ${JSON.stringify(mode)})`)

  /** @type {Check[]} */
  const checks = []
  if (!Array.isArray(raw.checks)) problems.push('checks must be a list, e.g.  checks:\n      - suite: smoke')
  else if (!raw.checks.length) problems.push('checks is empty: add at least one suite, tests or localization check')
  else
    raw.checks.forEach((c, i) => {
      const at = `checks[${i}]`
      if (!isObject(c)) return void problems.push(`${at} must be a mapping such as { suite: smoke }`)
      const known = ['name', 'suite', 'tests', 'localization', 'required', 'browser', 'viewport', 'timeoutMinutes']
      for (const k of Object.keys(c)) if (!known.includes(k)) problems.push(`${at}: ${unknownKey(k, known)}`)
      const kinds = /** @type {const} */ (['suite', 'tests', 'localization']).filter((k) => c[k] !== undefined && c[k] !== null)
      if (kinds.length !== 1) return void problems.push(`${at} needs exactly one of suite, tests or localization`)
      const type = kinds[0]
      /** @type {Check} */
      const check = { name: '', type, required: true, timeoutMinutes: 30 }
      if (c.required !== undefined) {
        if (typeof c.required !== 'boolean') problems.push(`${at}.required must be true or false`)
        else check.required = c.required
      }
      if (c.timeoutMinutes !== undefined) {
        const n = Number(c.timeoutMinutes)
        if (!Number.isFinite(n) || n < 1 || n > 240) problems.push(`${at}.timeoutMinutes must be between 1 and 240`)
        else check.timeoutMinutes = n
      }
      if (type === 'suite') {
        if (typeof c.suite !== 'string' && typeof c.suite !== 'number') problems.push(`${at}.suite must be a suite key, id or name`)
        else check.suite = String(c.suite).trim()
      }
      if (type === 'tests') {
        const list = typeof c.tests === 'string' ? [c.tests] : c.tests
        if (!Array.isArray(list) || !list.length || list.some((t) => typeof t !== 'string' || !t.trim())) problems.push(`${at}.tests must be a list of test keys`)
        else check.tests = list.map((t) => String(t).trim())
      }
      if (type === 'suite' || type === 'tests') {
        if (c.browser !== undefined && !BROWSERS.includes(String(c.browser))) problems.push(`${at}.browser must be one of ${BROWSERS.join(', ')}`)
        else if (c.browser !== undefined) check.browser = String(c.browser)
        if (c.viewport !== undefined && !VIEWPORTS.includes(String(c.viewport))) problems.push(`${at}.viewport must be one of ${VIEWPORTS.join(', ')}`)
        else if (c.viewport !== undefined) check.viewport = String(c.viewport)
      } else if (c.browser !== undefined || c.viewport !== undefined) problems.push(`${at}: browser and viewport apply to suite and tests checks only`)
      if (type === 'localization') {
        const l = c.localization === true ? {} : c.localization
        if (!isObject(l)) problems.push(`${at}.localization must be a mapping (or true)`)
        else {
          const lk = ['locales', 'minCoverage', 'minMqm', 'requireApproved']
          for (const k of Object.keys(l)) if (!lk.includes(k)) problems.push(`${at}.localization: ${unknownKey(k, lk)}`)
          /** @type {LocalizationRule} */
          const rule = { requireApproved: true }
          if (l.locales !== undefined) {
            const locales = typeof l.locales === 'string' ? [l.locales] : l.locales
            if (!Array.isArray(locales) || locales.some((x) => typeof x !== 'string')) problems.push(`${at}.localization.locales must be a list of locale tags`)
            else rule.locales = locales
          }
          if (l.minCoverage !== undefined) {
            const n = Number(l.minCoverage)
            if (!Number.isFinite(n) || n < 0 || n > 100) problems.push(`${at}.localization.minCoverage must be 0–100`)
            else rule.minCoverage = n
          }
          if (l.minMqm !== undefined) {
            const n = Number(l.minMqm)
            if (!Number.isFinite(n)) problems.push(`${at}.localization.minMqm must be a number`)
            else rule.minMqm = n
          }
          if (l.requireApproved !== undefined) {
            if (typeof l.requireApproved !== 'boolean') problems.push(`${at}.localization.requireApproved must be true or false`)
            else rule.requireApproved = l.requireApproved
          }
          check.localization = rule
        }
      }
      check.name = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : type === 'suite' ? `Suite ${check.suite}` : type === 'tests' ? `Tests ${check.tests?.join(', ')}` : 'Localization'
      checks.push(check)
    })

  const report = { dir: '.releasegate', junit: true, markdown: true }
  if (raw.report !== undefined) {
    if (!isObject(raw.report)) problems.push('report must be a mapping, e.g.  report: { dir: .releasegate }')
    else {
      const rk = ['dir', 'junit', 'markdown']
      for (const k of Object.keys(raw.report)) if (!rk.includes(k)) problems.push(`report: ${unknownKey(k, rk)}`)
      if (raw.report.dir !== undefined) report.dir = String(raw.report.dir)
      if (raw.report.junit !== undefined) report.junit = raw.report.junit !== false
      if (raw.report.markdown !== undefined) report.markdown = raw.report.markdown !== false
    }
  }
  const readableMode = mode === 'enforce' || mode === 'shadow' ? mode : undefined
  if (problems.length) throw new PolicyError(`${shown} has ${problems.length} problem${problems.length > 1 ? 's' : ''}:`, problems, readableMode)
  return { file, version: 1, project, mode: /** @type {'enforce' | 'shadow'} */ (mode), checks, report }
}
