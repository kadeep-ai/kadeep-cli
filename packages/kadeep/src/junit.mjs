// @ts-check

/** @param {unknown} s */
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')

/**
 * JUnit XML for CI dashboards, built from run results so it is the same whichever route produced them.
 * A suite with an `error` and no runs becomes one errored test case, so the report never shows a silent zero.
 * @param {Array<{ name: string, error?: string, runs: Array<{ name: string, status: string, verdict?: string, durationMs?: number, error?: string, summary?: string }> }>} suites
 */
export function junitXml(suites) {
  const blocks = suites.map((s) => {
    const cases = s.runs.map((r) => {
      const time = ((r.durationMs ?? 0) / 1000).toFixed(3)
      const open = `    <testcase classname="${esc(s.name)}" name="${esc(r.name)}" time="${time}"`
      if (r.status === 'passed') return `${open}/>`
      const why = r.error || r.summary || r.verdict || r.status
      return `${open}>\n      <failure message="${esc(why)}" type="${esc(r.verdict ?? r.status)}">${esc([r.error, r.summary].filter(Boolean).join('\n\n'))}</failure>\n    </testcase>`
    })
    if (!s.runs.length && s.error) cases.push(`    <testcase classname="${esc(s.name)}" name="${esc(s.name)}" time="0">\n      <error message="${esc(s.error)}"/>\n    </testcase>`)
    const failures = s.runs.filter((r) => r.status !== 'passed').length
    const errors = !s.runs.length && s.error ? 1 : 0
    const time = (s.runs.reduce((t, r) => t + (r.durationMs ?? 0), 0) / 1000).toFixed(3)
    return `  <testsuite name="${esc(s.name)}" tests="${s.runs.length + errors}" failures="${failures}" errors="${errors}" time="${time}">\n${cases.join('\n')}\n  </testsuite>`
  })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${blocks.join('\n')}\n</testsuites>\n`
}
