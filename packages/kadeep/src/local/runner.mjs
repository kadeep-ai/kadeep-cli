// @ts-check
import { EXIT, KadeepError } from '../errors.mjs'

/**
 * The local runner's agent loop: a QA engineer (the model) drives a browser (`BrowserTools`) toward a goal and ends
 * with a verdict. Transport-free, so tests can give it a fake model and a fake browser.
 *
 * The conversation is append-only (every response's content goes back unchanged, thinking blocks included) and
 * cached with top-level `cache_control`, so each turn pays for what is new only.
 *
 * @typedef {{ title: string, severity: 'critical' | 'major' | 'minor', steps?: string[], expected?: string, actual?: string, url?: string, screenshot?: string }} Bug
 * @typedef {{ n: number, action: string, input: Record<string, unknown>, ok: boolean, result?: string, error?: string, url?: string, screenshot?: string }} Step
 * @typedef {{
 *   ok: boolean, verdict: 'pass' | 'fail' | 'error', summary: string, url: string, goal: string,
 *   steps: Step[], bugs: Bug[], checks: Array<{ check: string, passed: boolean, detail?: string }>,
 *   console: import('./browser.mjs').ConsoleEntry[], network: import('./browser.mjs').NetworkEntry[],
 *   artifacts: { dir: string, screenshots: string[], report?: string },
 *   model: { provider: string, model: string, turns: number, usage: { input: number, output: number, cacheRead: number } },
 *   durationMs: number, claimUrl?: string
 * }} TestResult
 */

const ref = { type: 'string', description: 'Element ref from the latest snapshot, e.g. e12' }

/** The tools the model may call. Browser actions return the new page snapshot, so the model never acts blind. */
export const TOOLS = [
  { name: 'navigate', description: 'Open a URL in the tab.', input_schema: obj({ url: { type: 'string' } }, ['url']) },
  { name: 'click', description: 'Click an element.', input_schema: obj({ ref, element: { type: 'string', description: 'What you are clicking, in words' } }, ['ref']) },
  { name: 'fill', description: 'Type into a text field (replaces its value). submit: true presses Enter after.', input_schema: obj({ ref, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']) },
  { name: 'select', description: 'Choose option(s) in a <select>.', input_schema: obj({ ref, values: { type: 'array', items: { type: 'string' } } }, ['ref', 'values']) },
  { name: 'check', description: 'Tick (or with checked: false, untick) a checkbox or radio.', input_schema: obj({ ref, checked: { type: 'boolean' } }, ['ref']) },
  { name: 'hover', description: 'Hover an element.', input_schema: obj({ ref }, ['ref']) },
  { name: 'press', description: 'Press a key, e.g. Enter, Escape, Tab, ArrowDown.', input_schema: obj({ key: { type: 'string' } }, ['key']) },
  { name: 'scroll', description: 'Scroll the page.', input_schema: obj({ direction: { type: 'string', enum: ['up', 'down'] } }, ['direction']) },
  { name: 'back', description: 'Browser back.', input_schema: obj({}) },
  { name: 'wait', description: 'Wait for text to appear, or for some seconds (max 10).', input_schema: obj({ text: { type: 'string' }, seconds: { type: 'number' } }) },
  { name: 'look', description: 'Take a screenshot to check what the page looks like (layout, images, visual bugs). Costs more than the snapshot; use it when appearance matters.', input_schema: obj({}) },
  {
    name: 'report_bug',
    description: 'Record a defect you observed: something broken, wrong, missing or misleading for a user. Be specific and reproducible.',
    input_schema: obj(
      {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'major', 'minor'] },
        steps: { type: 'array', items: { type: 'string' } },
        expected: { type: 'string' },
        actual: { type: 'string' }
      },
      ['title', 'severity', 'actual']
    )
  },
  {
    name: 'finish',
    description: 'End the test with a verdict. pass: the goal works for a user. fail: it does not, or you found a critical or major bug. List each thing you checked.',
    input_schema: obj(
      {
        verdict: { type: 'string', enum: ['pass', 'fail'] },
        summary: { type: 'string', description: 'Two or three sentences a developer can act on' },
        checks: { type: 'array', items: obj({ check: { type: 'string' }, passed: { type: 'boolean' }, detail: { type: 'string' } }, ['check', 'passed']) }
      },
      ['verdict', 'summary']
    )
  }
]

/** @param {Record<string, object>} properties @param {string[]} [required] */
function obj(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

const SYSTEM = [
  'You are a senior QA engineer testing a web application in a real browser, on behalf of a developer or their coding agent.',
  'You get a goal and a starting URL. Work like a careful user would: read the page snapshot, act through the tools, and check that what should happen does happen.',
  'The snapshot is the page\'s accessibility tree; act on elements by their [ref=eN]. Every action returns the new snapshot plus any new console errors and failed requests.',
  'Rules:',
  '- Verify outcomes, not just that clicks succeed. A pass needs evidence on the page.',
  '- Report each real defect with report_bug as you find it (wrong behaviour, errors shown to the user, broken layout, dead links, uncaught exceptions, failing API calls the user would notice). Do not report style opinions.',
  '- Use test data that is obviously fake (e.g. test+kadeep@example.com). Never enter real payment details; stop at the last step before an irreversible real-world action and say so in the summary.',
  '- If you are blocked (login wall without credentials, captcha, site down), finish with verdict fail and explain exactly what blocked you.',
  '- Be efficient. Finish as soon as the goal is verified or clearly broken. Always end by calling finish.'
].join('\n')

/**
 * @param {import('./browser.mjs').ConsoleEntry[]} consoleNew
 * @param {import('./browser.mjs').NetworkEntry[]} networkNew
 */
function evidenceText(consoleNew, networkNew) {
  const lines = []
  for (const c of consoleNew.slice(0, 10)) lines.push(`${c.kind === 'pageerror' ? 'Uncaught exception' : 'Console error'}: ${c.text}`)
  for (const n of networkNew.slice(0, 10)) lines.push(`Failed request: ${n.method} ${n.url} → ${n.status || 'network error'} ${n.statusText ?? ''}`.trim())
  return lines.length ? `\nNew since last step:\n${lines.join('\n')}` : ''
}

/**
 * @param {{
 *   url: string, goal: string, model: import('./model.mjs').Model, browser: import('./browser.mjs').BrowserTools,
 *   dir: string, maxSteps?: number, onStep?: (s: Step) => void, signal?: AbortSignal, now?: () => number
 * }} input
 * @returns {Promise<TestResult>}
 */
export async function runAgent({ url, goal, model, browser, dir, maxSteps = 30, onStep = () => undefined, signal, now = Date.now }) {
  const started = now()
  /** @type {Step[]} */
  const steps = []
  /** @type {Bug[]} */
  const bugs = []
  const usage = { input: 0, output: 0, cacheRead: 0 }
  let turns = 0
  /** @type {{ verdict: 'pass' | 'fail' | 'error', summary: string, checks: any[] } | undefined} */
  let finished

  const opened = await browser.act('navigate', { url }).catch((err) => {
    throw new KadeepError(`Could not open ${url}: ${/** @type {Error} */ (err).message.split('\n')[0]}`, { code: 'unreachable_url', exitCode: EXIT.NETWORK })
  })
  const first = await browser.snapshot()
  const firstShot = await browser.screenshot('start').catch(() => undefined)
  const d0 = browser.drain()
  steps.push({ n: 0, action: 'navigate', input: { url }, ok: true, result: opened, url: first.url, screenshot: firstShot?.path })

  /** @type {any[]} */
  const messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: `Goal: ${goal}\nStarting URL: ${url}\nYou have at most ${maxSteps} actions.` },
        { type: 'text', text: `${opened}\nPage: ${first.title} — ${first.url}\n\nSnapshot:\n${first.snapshot}${evidenceText(d0.console, d0.network)}` }
      ]
    }
  ]

  let actions = 0
  while (!finished) {
    if (signal?.aborted) throw new KadeepError('Stopped.', { code: 'aborted', exitCode: 130 })
    const res = await model.create({ max_tokens: 16000, system: SYSTEM, tools: TOOLS, tool_choice: { type: 'auto' }, messages, cache_control: { type: 'ephemeral' } })
    turns++
    usage.input += res.usage?.input_tokens ?? 0
    usage.output += res.usage?.output_tokens ?? 0
    usage.cacheRead += res.usage?.cache_read_input_tokens ?? 0
    messages.push({ role: 'assistant', content: res.content })

    if (res.stop_reason === 'refusal') {
      finished = { verdict: 'error', summary: `The model declined to continue this test${res.stop_details?.explanation ? `: ${res.stop_details.explanation}` : '.'}`, checks: [] }
      break
    }
    /** @type {any[]} */
    const calls = (res.content ?? []).filter((/** @type {any} */ b) => b.type === 'tool_use')
    if (!calls.length) {
      if (res.stop_reason === 'pause_turn') continue
      if (turns >= 3 && !steps.some((s) => s.n > 0)) {
        finished = { verdict: 'error', summary: 'The model stopped without testing anything.', checks: [] }
        break
      }
      messages.push({ role: 'user', content: [{ type: 'text', text: 'Continue the test with the tools, and call finish when you have a verdict.' }] })
      continue
    }

    /** @type {any[]} */
    const results = []
    for (const call of calls) {
      const input = call.input && typeof call.input === 'object' ? call.input : {}
      if (call.name === 'finish') {
        finished = { verdict: input.verdict === 'pass' ? 'pass' : 'fail', summary: String(input.summary ?? ''), checks: Array.isArray(input.checks) ? input.checks : [] }
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'Recorded.' })
        continue
      }
      if (call.name === 'report_bug') {
        const page = await browser.snapshot().catch(() => ({ url: '' }))
        const shot = await browser.screenshot(`bug-${bugs.length + 1}`).catch(() => undefined)
        bugs.push({ title: String(input.title ?? 'Untitled'), severity: ['critical', 'major', 'minor'].includes(input.severity) ? input.severity : 'major', steps: Array.isArray(input.steps) ? input.steps.map(String) : undefined, expected: input.expected, actual: input.actual, url: page.url, screenshot: shot?.path })
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Bug ${bugs.length} recorded.` })
        continue
      }
      if (call.name === 'look') {
        const shot = await browser.screenshot('look').catch((err) => ({ error: String(err?.message ?? err) }))
        results.push('base64' in shot ? { type: 'tool_result', tool_use_id: call.id, content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: shot.base64 } }] } : { type: 'tool_result', tool_use_id: call.id, content: `No screenshot: ${shot.error}`, is_error: true })
        continue
      }
      if (actions >= maxSteps) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: `Action limit (${maxSteps}) reached. Call finish now with what you know.`, is_error: true })
        continue
      }
      actions++
      /** @type {Step} */
      const step = { n: actions, action: call.name, input, ok: true }
      try {
        step.result = await browser.act(call.name, input)
      } catch (err) {
        step.ok = false
        step.error = /** @type {Error} */ (err).message.split('\n')[0].slice(0, 300)
      }
      const snap = await browser.snapshot()
      step.url = snap.url
      step.screenshot = (await browser.screenshot(call.name).catch(() => undefined))?.path
      const d = browser.drain()
      steps.push(step)
      onStep(step)
      const head = step.ok ? String(step.result) : `Action failed: ${step.error}`
      results.push({ type: 'tool_result', tool_use_id: call.id, content: `${head}\nPage: ${snap.title} — ${snap.url}\n\nSnapshot:\n${snap.snapshot}${evidenceText(d.console, d.network)}`, ...(step.ok ? {} : { is_error: true }) })
    }
    messages.push({ role: 'user', content: results })
    if (!finished && turns >= maxSteps + 6) finished = { verdict: 'error', summary: `Stopped after ${maxSteps} actions without a verdict.`, checks: [] }
  }

  const ev = browser.evidence()
  const verdict = finished.verdict === 'pass' && bugs.some((b) => b.severity === 'critical') ? 'fail' : finished.verdict
  return {
    ok: verdict === 'pass',
    verdict,
    summary: finished.summary,
    url,
    goal,
    steps,
    bugs,
    checks: finished.checks,
    console: ev.console,
    network: ev.network,
    artifacts: { dir, screenshots: ev.screenshots },
    model: { provider: model.provider, model: model.model, turns, usage },
    durationMs: now() - started
  }
}
