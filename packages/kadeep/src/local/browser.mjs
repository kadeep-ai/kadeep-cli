// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The browser the local runner's agent drives: one Playwright page, addressed by the refs in its AI snapshot
 * (`[ref=e5]`), with console errors, page errors and failed requests recorded as evidence. Screenshots are written to
 * the run's artifact directory after every action.
 *
 * @typedef {{ kind: 'console' | 'pageerror', text: string, url?: string }} ConsoleEntry
 * @typedef {{ method: string, url: string, status: number, statusText?: string }} NetworkEntry
 * @typedef {{
 *   snapshot: () => Promise<{ url: string, title: string, snapshot: string }>,
 *   act: (name: string, input: any) => Promise<string>,
 *   screenshot: (label: string) => Promise<{ path: string, base64: string }>,
 *   drain: () => { console: ConsoleEntry[], network: NetworkEntry[] },
 *   evidence: () => { console: ConsoleEntry[], network: NetworkEntry[], screenshots: string[] },
 *   page: any,
 *   close: () => Promise<void>
 * }} BrowserTools
 */

export const VIEWPORTS = Object.freeze({ desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } })
const SNAPSHOT_LIMIT = 12_000

/**
 * @param {any} browser  a Playwright Browser
 * @param {{ viewport?: 'desktop' | 'mobile', dir: string, storageState?: string, headers?: Record<string, string> }} opts
 * @returns {Promise<BrowserTools>}
 */
export async function openBrowserTools(browser, { viewport = 'desktop', dir, storageState, headers }) {
  mkdirSync(dir, { recursive: true })
  const mobile = viewport === 'mobile'
  const context = await browser.newContext({ viewport: VIEWPORTS[viewport], ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}), ...(storageState ? { storageState } : {}), ...(headers ? { extraHTTPHeaders: headers } : {}), ignoreHTTPSErrors: true })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  /** @type {ConsoleEntry[]} */
  const consoleAll = []
  /** @type {NetworkEntry[]} */
  const networkAll = []
  let consoleSeen = 0
  let networkSeen = 0
  /** @type {string[]} */
  const screenshots = []
  let shot = 0

  page.on('console', (/** @type {any} */ m) => {
    if (m.type() === 'error') consoleAll.push({ kind: 'console', text: String(m.text()).slice(0, 500), url: m.location?.()?.url })
  })
  page.on('pageerror', (/** @type {any} */ e) => consoleAll.push({ kind: 'pageerror', text: String(e?.message ?? e).slice(0, 500) }))
  page.on('response', (/** @type {any} */ r) => {
    const status = r.status()
    if (status >= 400) networkAll.push({ method: r.request().method(), url: r.url().slice(0, 300), status, statusText: r.statusText() })
  })
  page.on('requestfailed', (/** @type {any} */ r) => networkAll.push({ method: r.method(), url: r.url().slice(0, 300), status: 0, statusText: r.failure()?.errorText }))

  /** @param {string} ref */
  const at = (ref) => {
    if (!/^e\d+$/.test(String(ref ?? ''))) throw new Error(`"${ref}" is not a ref from the snapshot (they look like e12)`)
    return page.locator(`aria-ref=${ref}`)
  }
  const settle = async () => {
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => undefined)
    await page.waitForTimeout(300)
  }

  /** @type {BrowserTools} */
  const tools = {
    page,
    async snapshot() {
      let text = ''
      try {
        text = await page.ariaSnapshot({ mode: 'ai', timeout: 5000 })
      } catch (err) {
        text = `(no snapshot: ${/** @type {Error} */ (err).message.split('\n')[0]})`
      }
      if (text.length > SNAPSHOT_LIMIT) text = `${text.slice(0, SNAPSHOT_LIMIT)}\n… (snapshot cut at ${SNAPSHOT_LIMIT} characters; scroll or navigate to see more)`
      return { url: page.url(), title: await page.title().catch(() => ''), snapshot: text }
    },
    async act(name, input) {
      switch (name) {
        case 'navigate': {
          const url = String(input.url ?? '')
          if (!/^https?:\/\//i.test(url)) throw new Error('navigate takes an http(s) URL')
          const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          await settle()
          return `Opened ${page.url()}${res ? ` (HTTP ${res.status()})` : ''}`
        }
        case 'click':
          await at(input.ref).click()
          await settle()
          return `Clicked ${input.ref}`
        case 'fill':
          await at(input.ref).fill(String(input.text ?? ''))
          if (input.submit) await at(input.ref).press('Enter')
          await settle()
          return `Filled ${input.ref}${input.submit ? ' and pressed Enter' : ''}`
        case 'select':
          await at(input.ref).selectOption(Array.isArray(input.values) ? input.values.map(String) : [String(input.values)])
          await settle()
          return `Selected in ${input.ref}`
        case 'check':
          await (input.checked === false ? at(input.ref).uncheck() : at(input.ref).check())
          await settle()
          return `${input.checked === false ? 'Unchecked' : 'Checked'} ${input.ref}`
        case 'hover':
          await at(input.ref).hover()
          return `Hovered ${input.ref}`
        case 'press':
          await page.keyboard.press(String(input.key))
          await settle()
          return `Pressed ${input.key}`
        case 'scroll':
          await page.mouse.wheel(0, input.direction === 'up' ? -700 : 700)
          await page.waitForTimeout(250)
          return `Scrolled ${input.direction === 'up' ? 'up' : 'down'}`
        case 'back':
          await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined)
          await settle()
          return `Went back to ${page.url()}`
        case 'wait': {
          if (input.text) {
            await page.getByText(String(input.text)).first().waitFor({ timeout: Math.min(30, Number(input.seconds) || 10) * 1000 })
            return `"${input.text}" is visible`
          }
          await page.waitForTimeout(Math.min(10, Math.max(0.2, Number(input.seconds) || 1)) * 1000)
          return 'Waited'
        }
        default:
          throw new Error(`Unknown action ${name}`)
      }
    },
    async screenshot(label) {
      const file = join(dir, `${String(++shot).padStart(2, '0')}-${label.replace(/[^\w-]+/g, '-').slice(0, 40)}.jpg`)
      const buf = await page.screenshot({ type: 'jpeg', quality: 60, timeout: 10_000 })
      writeFileSync(file, buf)
      screenshots.push(file)
      return { path: file, base64: buf.toString('base64') }
    },
    drain() {
      const out = { console: consoleAll.slice(consoleSeen), network: networkAll.slice(networkSeen) }
      consoleSeen = consoleAll.length
      networkSeen = networkAll.length
      return out
    },
    evidence: () => ({ console: [...consoleAll], network: [...networkAll], screenshots: [...screenshots] }),
    async close() {
      await context.close().catch(() => undefined)
    }
  }
  return tools
}

/** Write the run's report next to its screenshots. @param {string} dir @param {unknown} report */
export function writeReport(dir, report) {
  const file = join(dir, 'report.json')
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
  return file
}
