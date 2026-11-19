// @ts-check
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EXIT, KadeepError } from '../errors.mjs'

/**
 * The local runner's runtime: Playwright, the Anthropic SDK and axe-core. `kadeep` itself has no dependencies, so the
 * core commands install in a second; the first `kadeep test` or `kadeep a11y` installs these once into a cache
 * directory (or uses them from the current project when it already has them) and reuses them after that.
 */
export const RUNTIME = Object.freeze({ 'playwright-core': '1.65.1', '@anthropic-ai/sdk': '1.11.0', 'axe-core': '4.14.1' })

const RUNTIME_KEY = Object.entries(RUNTIME).map(([n, v]) => `${n.replace(/[@/]/g, '')}-${v}`).join('_')

/** Where the runtime is installed: $KADEEP_RUNTIME_DIR, $XDG_CACHE_HOME/kadeep/runtime, ~/.cache/kadeep/runtime. */
export function runtimeDir(env = process.env) {
  if (env.KADEEP_RUNTIME_DIR) return env.KADEEP_RUNTIME_DIR
  const base = env.XDG_CACHE_HOME || (process.platform === 'win32' && env.LOCALAPPDATA) || join(homedir(), '.cache')
  return join(base, 'kadeep', 'runtime', RUNTIME_KEY)
}

/**
 * Resolve a runtime package: from the current project first (so a repo that pins Playwright uses its own), then the
 * cache. Returns the module's file URL, or undefined.
 * @param {string} name
 * @param {string[]} roots
 */
function locate(name, roots) {
  for (const root of roots) {
    try {
      return pathToFileURL(createRequire(join(root, 'noop.js')).resolve(name)).href
    } catch {
      /* not here */
    }
  }
  return undefined
}

/**
 * Install the runtime into the cache directory with npm. Progress goes to stderr.
 * @param {string} dir
 * @param {(line: string) => void} note
 * @param {NodeJS.ProcessEnv} env
 */
function install(dir, note, env) {
  mkdirSync(dir, { recursive: true })
  if (!existsSync(join(dir, 'package.json'))) writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'kadeep-runtime', private: true }, null, 2)}\n`)
  note(`Installing the local test runtime once (${Object.keys(RUNTIME).join(', ')}) into ${dir}`)
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const specs = Object.entries(RUNTIME).map(([n, v]) => `${n}@${v}`)
  const r = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--no-save', '--loglevel=error', ...specs], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) throw new KadeepError(`Could not install the local test runtime with npm: ${(r.stderr || r.error?.message || '').trim().split('\n').slice(-3).join(' ')}`, { code: 'runtime_install_failed', exitCode: EXIT.NETWORK })
}

/**
 * Load the runtime, installing it the first time.
 * @param {{ env?: NodeJS.ProcessEnv, note?: (line: string) => void, cwd?: string }} [opts]
 * @returns {Promise<{ playwright: any, Anthropic: any, axeSource: () => string, dir: string }>}
 */
export async function loadRuntime({ env = process.env, note = () => undefined, cwd = process.cwd() } = {}) {
  const dir = runtimeDir(env)
  const roots = [cwd, dir]
  const names = Object.keys(RUNTIME)
  if (names.some((n) => !locate(n, roots))) install(dir, note, env)
  /** @param {string} n */
  const url = (n) => {
    const u = locate(n, roots)
    if (!u) throw new KadeepError(`${n} is missing from ${dir} after installing it. Delete that directory and try again.`, { code: 'runtime_missing', exitCode: EXIT.FAILED })
    return u
  }
  const playwright = await import(url('playwright-core'))
  const sdk = await import(url('@anthropic-ai/sdk'))
  const axePath = new URL(url('axe-core')).pathname
  const { readFileSync } = await import('node:fs')
  return {
    playwright: playwright.default ?? playwright,
    Anthropic: sdk.default ?? sdk.Anthropic,
    axeSource: () => readFileSync(axePath.replace(/axe(\.min)?\.js$/, 'axe.min.js'), 'utf8'),
    dir
  }
}

/**
 * Launch a browser: an installed Google Chrome or Edge first (no download), then Playwright's own Chromium,
 * downloading it once if it is missing.
 * @param {any} playwright
 * @param {{ headed?: boolean, note?: (line: string) => void, env?: NodeJS.ProcessEnv, dir: string }} opts
 */
export async function launchBrowser(playwright, { headed = false, note = () => undefined, env = process.env, dir }) {
  const { chromium } = playwright
  const headless = !headed
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless })
    } catch {
      /* not installed */
    }
  }
  try {
    return await chromium.launch({ headless })
  } catch (err) {
    if (!/Executable doesn't exist|playwright install/i.test(String(/** @type {Error} */ (err)?.message))) throw err
  }
  note('Downloading Chromium for Playwright once (no Chrome or Edge found)')
  const cli = new URL(locate('playwright-core/cli.js', [process.cwd(), dir]) ?? '').pathname
  const r = spawnSync(process.execPath, [cli, 'install', ...(headless ? ['--only-shell'] : []), 'chromium'], { stdio: ['ignore', 'ignore', 'pipe'], env, encoding: 'utf8' })
  if (r.status !== 0) throw new KadeepError(`Could not download Chromium: ${(r.stderr || '').trim().split('\n').slice(-2).join(' ')}`, { code: 'browser_install_failed', exitCode: EXIT.NETWORK })
  return chromium.launch({ headless })
}
