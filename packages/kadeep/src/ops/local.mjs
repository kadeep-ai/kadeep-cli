// @ts-check
import { resolve } from 'node:path'
import { EXIT, KadeepError } from '../errors.mjs'
import { auditPage, STANDARDS } from '../local/a11y.mjs'
import { openBrowserTools, writeReport } from '../local/browser.mjs'
import { createModel, kadeepModelToken } from '../local/model.mjs'
import { runAgent } from '../local/runner.mjs'
import { launchBrowser, loadRuntime } from '../local/runtime.mjs'

/**
 * Local testing, shared by `kadeep test`, `kadeep a11y` and the MCP tools: it runs on this machine, so it reaches
 * localhost, staging behind a VPN and preview URLs, and needs no KaDeep project.
 */

export const DEFAULT_GOAL = 'Explore this page like a first-time user: find its main purpose, try the primary journey end to end, and report every bug you find.'

/** @param {string} raw */
export function normalizeUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) throw new KadeepError('Give a URL to test, e.g. `kadeep test http://localhost:3000 "sign up works"`', { code: 'usage', exitCode: EXIT.USAGE })
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(s) ? `http://${s}` : `https://${s}`
  let u
  try {
    u = new URL(withScheme)
  } catch {
    throw new KadeepError(`"${s}" is not a URL`, { code: 'usage', exitCode: EXIT.USAGE })
  }
  if (!/^https?:$/.test(u.protocol)) throw new KadeepError('Only http and https URLs can be tested', { code: 'usage', exitCode: EXIT.USAGE })
  return u.href
}

/** `.kadeep/runs/<time>-<host>` under the current directory, or --out. @param {string} url @param {string} [out] */
export function artifactDir(url, out) {
  if (out) return resolve(out)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const host = new URL(url).host.replace(/[^\w.-]+/g, '-')
  return resolve('.kadeep', 'runs', `${stamp}-${host}`)
}

/**
 * @param {{
 *   url: string, goal?: string, env: NodeJS.ProcessEnv, api: string, headed?: boolean, viewport?: 'desktop' | 'mobile',
 *   maxSteps?: number, model?: string, provider?: string, effort?: string, out?: string, storageState?: string,
 *   note?: (line: string) => void, onStep?: (s: import('../local/runner.mjs').Step) => void, signal?: AbortSignal
 * }} opts
 * @returns {Promise<import('../local/runner.mjs').TestResult>}
 */
export async function localTest(opts) {
  const url = normalizeUrl(opts.url)
  const goal = (opts.goal ?? '').trim() || DEFAULT_GOAL
  const note = opts.note ?? (() => undefined)
  const rt = await loadRuntime({ env: opts.env, note })
  const model = createModel({ Anthropic: rt.Anthropic, api: opts.api, env: opts.env, provider: opts.provider, model: opts.model, effort: opts.effort })
  const dir = artifactDir(url, opts.out)
  const browser = await launchBrowser(rt.playwright, { headed: opts.headed, note, env: opts.env, dir: rt.dir })
  try {
    const tools = await openBrowserTools(browser, { viewport: opts.viewport, dir, storageState: opts.storageState })
    try {
      note(`Testing ${url} on ${model.provider === 'kadeep' ? "KaDeep's plan" : 'your Anthropic account'} (${model.model})`)
      const result = await runAgent({ url, goal, model, browser: tools, dir, maxSteps: opts.maxSteps, onStep: opts.onStep, signal: opts.signal })
      const trial = model.provider === 'kadeep' ? kadeepModelToken({ api: opts.api, env: opts.env }) : undefined
      if (trial?.kind === 'try' && trial.claimUrl) result.claimUrl = trial.claimUrl
      result.artifacts.report = writeReport(dir, result)
      return result
    } finally {
      await tools.close()
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/**
 * @param {{ url: string, env: NodeJS.ProcessEnv, standard?: string, failOn?: string, viewport?: 'desktop' | 'mobile', out?: string, note?: (line: string) => void }} opts
 * @returns {Promise<import('../local/a11y.mjs').A11yResult & { artifacts: { dir: string, report: string } }>}
 */
export async function localA11y(opts) {
  const url = normalizeUrl(opts.url)
  const standard = /** @type {keyof typeof STANDARDS} */ (opts.standard ?? 'wcag22aa')
  if (!(standard in STANDARDS)) throw new KadeepError(`--standard must be one of ${Object.keys(STANDARDS).join(', ')}`, { code: 'usage', exitCode: EXIT.USAGE })
  const failOn = /** @type {any} */ (opts.failOn ?? 'serious')
  if (!['critical', 'serious', 'moderate', 'minor'].includes(failOn)) throw new KadeepError('--fail-on must be critical, serious, moderate or minor', { code: 'usage', exitCode: EXIT.USAGE })
  const note = opts.note ?? (() => undefined)
  const rt = await loadRuntime({ env: opts.env, note })
  const dir = artifactDir(url, opts.out)
  const browser = await launchBrowser(rt.playwright, { note, env: opts.env, dir: rt.dir })
  try {
    const tools = await openBrowserTools(browser, { viewport: opts.viewport, dir })
    try {
      const result = await auditPage({ page: tools.page, axeSource: rt.axeSource(), url, standard, failOn })
      const report = writeReport(dir, result)
      return { ...result, artifacts: { dir, report } }
    } catch (err) {
      if (err instanceof KadeepError) throw err
      throw new KadeepError(`Could not audit ${url}: ${/** @type {Error} */ (err).message.split('\n')[0]}`, { code: 'unreachable_url', exitCode: EXIT.NETWORK })
    } finally {
      await tools.close()
    }
  } finally {
    await browser.close().catch(() => undefined)
  }
}
