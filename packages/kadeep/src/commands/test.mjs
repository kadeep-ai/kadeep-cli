// @ts-check
import { relative } from 'node:path'
import { EXIT, usage } from '../errors.mjs'
import { duration } from '../output.mjs'
import { localA11y, localTest } from '../ops/local.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** A path relative to where the command ran, for printing. @param {string} p */
const rel = (p) => relative(process.cwd(), p) || '.'

/** @type {Command} */
const test = {
  name: 'test',
  summary: 'Test any URL (localhost too) with the AI QA agent, here on this machine',
  usage: [
    'kadeep test <url> ["what to check"] [--viewport desktop|mobile] [--headed] [--max-steps 30] [--out <dir>]',
    'kadeep test http://localhost:3000 "sign up with a new email and reach the dashboard"',
    'kadeep test https://staging.example.com "add two items to the cart and check the total" --json',
    'Runs Playwright locally, so it reaches localhost, previews and VPN-only staging. No KaDeep project needed.',
    'Model: ANTHROPIC_API_KEY (or `ant auth login`), else KaDeep\'s plan when signed in or on `kadeep try`.',
    '  --model <id> (default claude-opus-5-5) · --provider anthropic|kadeep · --effort low|medium|high',
    '  --storage-state <file> starts signed in (a Playwright storage state JSON).',
    'Exit: 0 pass · 1 fail (bugs found or goal broken) · 2 usage or no model · 3 URL or model unreachable · 4 no verdict.',
    'Evidence (report.json, a screenshot per step) goes to .kadeep/runs/<time>-<host>/.'
  ],
  options: {
    viewport: { type: 'string' },
    headed: { type: 'boolean' },
    'max-steps': { type: 'string' },
    out: { type: 'string' },
    model: { type: 'string' },
    provider: { type: 'string' },
    effort: { type: 'string' },
    'storage-state': { type: 'string' }
  },
  async run({ values, positionals, out, env, api, num, signal }) {
    const [url, ...goalWords] = positionals
    if (!url) throw usage('Give a URL to test: kadeep test <url> ["what to check"]')
    if (values.viewport && !['desktop', 'mobile'].includes(values.viewport)) throw usage('--viewport must be desktop or mobile')
    if (values.effort && !['low', 'medium', 'high', 'xhigh', 'max'].includes(values.effort)) throw usage('--effort must be low, medium, high, xhigh or max')
    const { style, g } = out.ui
    const result = await localTest({
      url,
      goal: goalWords.join(' '),
      env,
      api,
      headed: values.headed,
      viewport: values.viewport,
      maxSteps: num('max-steps'),
      model: values.model,
      provider: values.provider,
      effort: values.effort,
      out: values.out,
      storageState: values['storage-state'],
      signal,
      note: (line) => out.note(style.muted(line)),
      onStep: (s) => {
        if (out.json) return
        const what = s.action === 'fill' ? `fill ${s.input.ref} "${String(s.input.text ?? '').slice(0, 40)}"` : s.action === 'navigate' ? `open ${s.input.url}` : `${s.action}${s.input.ref ? ` ${s.input.element ?? s.input.ref}` : s.input.key ? ` ${s.input.key}` : ''}`
        out.note(`${s.ok ? style.muted(out.rich ? g.dot : '·') : style.fail(out.rich ? g.fail : '✗')} ${style.muted(String(s.n).padStart(2))} ${what}${s.ok ? '' : style.fail(`  ${s.error}`)}`)
      }
    })
    out.result(result, () => {
      const head = result.verdict === 'pass' ? style.ok(`${out.rich ? g.ok : '✓'} PASS`) : result.verdict === 'fail' ? style.fail(`${out.rich ? g.fail : '✗'} FAIL`) : style.warn('! NO VERDICT')
      out.line('')
      out.line(`${head}  ${result.summary}`)
      for (const c of result.checks) out.line(`  ${c.passed ? style.ok('✓') : style.fail('✗')} ${c.check}${c.detail ? style.muted(`  ${c.detail}`) : ''}`)
      if (result.bugs.length) {
        out.line('')
        out.line(style.bold(`${result.bugs.length} bug${result.bugs.length > 1 ? 's' : ''}`))
        for (const b of result.bugs) {
          out.line(`  ${b.severity === 'minor' ? style.warn('●') : style.fail('●')} [${b.severity}] ${b.title}`)
          if (b.actual) out.line(style.muted(`      actual: ${b.actual}`))
          if (b.expected) out.line(style.muted(`      expected: ${b.expected}`))
        }
      }
      const errs = result.console.length + result.network.length
      out.line('')
      out.line(style.muted(`${result.steps.length - 1} actions · ${duration(result.durationMs)}${errs ? ` · ${result.console.length} console errors, ${result.network.length} failed requests` : ''} · evidence ${rel(result.artifacts.dir)}`))
      if (result.claimUrl) out.line(style.muted(`Trial run. Keep it, and get the cloud runner, devices and CI gate: ${result.claimUrl}`))
    })
    return result.verdict === 'pass' ? EXIT.OK : result.verdict === 'fail' ? EXIT.FAILED : EXIT.NOT_READY
  }
}

/** @type {Command} */
const a11y = {
  name: 'a11y',
  summary: 'Accessibility audit of a URL (WCAG 2.2 AA, axe-core), here on this machine',
  usage: [
    'kadeep a11y <url> [--standard wcag22aa|wcag21aa|wcag2aa|wcag22a] [--fail-on serious] [--viewport mobile] [--out <dir>]',
    'kadeep a11y http://localhost:3000/checkout --json',
    'Deterministic: no model and no account. Exit 1 when a violation at or above --fail-on (default serious) is found.'
  ],
  options: { standard: { type: 'string' }, 'fail-on': { type: 'string' }, viewport: { type: 'string' }, out: { type: 'string' } },
  async run({ values, positionals, out, env }) {
    const [url] = positionals
    if (!url) throw usage('Give a URL to audit: kadeep a11y <url>')
    if (values.viewport && !['desktop', 'mobile'].includes(values.viewport)) throw usage('--viewport must be desktop or mobile')
    const { style } = out.ui
    const r = await localA11y({ url, env, standard: values.standard, failOn: values['fail-on'], viewport: values.viewport, out: values.out, note: (line) => out.note(style.muted(line)) })
    out.result(r, () => {
      out.line(`${r.ok ? style.ok('✓ PASS') : style.fail('✗ FAIL')}  ${r.violations.length} rule${r.violations.length === 1 ? '' : 's'} violated on ${r.url} (${r.standard})`)
      out.line(style.muted(`  critical ${r.counts.critical} · serious ${r.counts.serious} · moderate ${r.counts.moderate} · minor ${r.counts.minor} · ${r.passes} rules passed`))
      for (const v of r.violations) {
        out.line(`  ${v.impact === 'critical' || v.impact === 'serious' ? style.fail('●') : style.warn('●')} [${v.impact}] ${v.help} ${style.muted(`(${v.id}, ${v.nodes.length} element${v.nodes.length === 1 ? '' : 's'})`)}`)
        for (const n of v.nodes.slice(0, 3)) out.line(style.muted(`      ${n.target}`))
      }
      out.line(style.muted(`report ${rel(r.artifacts.report)} · automated rules catch part of WCAG; KaDeep Studios adds AI and expert review`))
    })
    return r.ok ? EXIT.OK : EXIT.FAILED
  }
}

export default [test, a11y]
