// @ts-check

/**
 * `kadeep a11y`: an automated WCAG audit of one page with axe-core, run locally in the same browser the test runner
 * uses. No model and no account: it is deterministic. Automated rules find about a third of WCAG issues; KaDeep
 * Studios' cloud audit adds the AI and human-judgement checks.
 *
 * @typedef {{ id: string, impact: 'critical' | 'serious' | 'moderate' | 'minor' | null, help: string, helpUrl: string, wcag: string[], nodes: Array<{ target: string, html: string, summary: string }> }} A11yViolation
 * @typedef {{ ok: boolean, url: string, standard: string, violations: A11yViolation[], counts: Record<string, number>, passes: number, incomplete: number, durationMs: number }} A11yResult
 */

export const STANDARDS = Object.freeze({
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag22a: ['wcag2a', 'wcag21a']
})

const IMPACTS = ['critical', 'serious', 'moderate', 'minor']

/**
 * @param {{ page: any, axeSource: string, url: string, standard?: keyof typeof STANDARDS, failOn?: 'critical' | 'serious' | 'moderate' | 'minor', now?: () => number }} input
 * @returns {Promise<A11yResult>}
 */
export async function auditPage({ page, axeSource, url, standard = 'wcag22aa', failOn = 'serious', now = Date.now }) {
  const started = now()
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  await page.waitForTimeout(500)
  await page.addScriptTag({ content: axeSource })
  const raw = await page.evaluate(async (/** @type {string[]} */ tags) => {
    // @ts-ignore axe is injected above
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] })
    return { violations: r.violations.map((/** @type {any} */ v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, tags: v.tags, nodes: v.nodes.slice(0, 10).map((/** @type {any} */ n) => ({ target: n.target.join(' '), html: String(n.html).slice(0, 200), summary: String(n.failureSummary ?? '').slice(0, 300) })) })), passes: r.passes.length, incomplete: r.incomplete.length }
  }, STANDARDS[standard])
  /** @type {A11yViolation[]} */
  const violations = raw.violations
    .map((/** @type {any} */ v) => ({ id: v.id, impact: v.impact, help: v.help, helpUrl: v.helpUrl, wcag: v.tags.filter((/** @type {string} */ t) => /^wcag\d/.test(t)), nodes: v.nodes }))
    .sort((/** @type {any} */ a, /** @type {any} */ b) => IMPACTS.indexOf(a.impact) - IMPACTS.indexOf(b.impact))
  /** @type {Record<string, number>} */
  const counts = Object.fromEntries(IMPACTS.map((i) => [i, violations.filter((v) => v.impact === i).length]))
  const threshold = IMPACTS.indexOf(failOn)
  const ok = !violations.some((v) => v.impact && IMPACTS.indexOf(v.impact) <= threshold)
  return { ok, url: page.url(), standard, violations, counts, passes: raw.passes, incomplete: raw.incomplete, durationMs: now() - started }
}
