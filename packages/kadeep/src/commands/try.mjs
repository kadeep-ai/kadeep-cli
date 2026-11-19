// @ts-check
import { loadConfig, updateConfig } from '../config.mjs'
import { EXIT, KadeepError, VERSION } from '../errors.mjs'
import { request } from '../http.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** Which coding agent, if any, is running us, from the environment it sets. @param {NodeJS.ProcessEnv} env */
export function detectAgent(env) {
  if (env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code'
  if (env.CURSOR_AGENT || env.CURSOR_TRACE_ID) return 'cursor'
  if (env.CODEX_SANDBOX || env.CODEX_HOME || env.CODEX_MANAGED_BY_NPM) return 'codex'
  if (env.GEMINI_CLI) return 'gemini-cli'
  if (env.OPENCODE || env.OPENCODE_BIN_PATH) return 'opencode'
  if (env.CLINE_TASK_ID) return 'cline'
  return null
}

/**
 * Start (or show) an anonymous trial: a short-lived token with a little AI credit and a sandbox project, so an agent
 * can test right away. A person claims it into an account with the claim link.
 * @param {{ api: string, env: NodeJS.ProcessEnv, fresh?: boolean }} opts
 * @returns {Promise<{ token: string, expiresAt?: string, claimUrl?: string, projectId?: string, limits?: { creditUsd?: number, expiresInHours?: number }, reused: boolean }>}
 */
export async function startTrial({ api, env, fresh = false }) {
  const known = loadConfig(env).trials?.[api]
  if (!fresh && known?.token && (!known.expiresAt || Date.parse(known.expiresAt) > Date.now())) return { ...known, reused: true }
  const res = await request(`${api}/api/public/try`, { method: 'POST', body: { client: `kadeep-cli/${VERSION}`, agent: detectAgent(env) }, timeoutMs: 30_000 }).catch((err) => {
    throw new KadeepError(`Could not reach ${api}: ${err.message}`, { code: 'unreachable', exitCode: EXIT.NETWORK })
  })
  /** @type {any} */
  let body = {}
  try {
    body = res.json()
  } catch {
    /* not JSON */
  }
  if (res.status === 404) throw new KadeepError(`${api} does not offer anonymous trials yet. Sign up free at https://kadeep.ai/start, or set ANTHROPIC_API_KEY to use \`kadeep test\` on your own key.`, { code: 'try_unavailable', exitCode: EXIT.USAGE, status: 404 })
  if (res.status === 403) throw new KadeepError(`${body.error ?? 'Anonymous trials are switched off right now.'} Sign up free at https://kadeep.ai/start, or set ANTHROPIC_API_KEY.`, { code: body.code ?? 'try_disabled', exitCode: EXIT.USAGE, status: 403 })
  if (res.status === 429) throw new KadeepError(`${body.error ?? 'Too many trials from this network today.'} Sign up free at https://kadeep.ai/start, or set ANTHROPIC_API_KEY.`, { code: body.code ?? 'try_rate_limited', exitCode: EXIT.USAGE, status: 429 })
  if (res.status < 200 || res.status >= 300 || !body.token) throw new KadeepError(`KaDeep could not start a trial (HTTP ${res.status})${body.error ? `: ${body.error}` : ''}`, { code: 'try_failed', exitCode: EXIT.NETWORK, status: res.status })
  const trial = { token: String(body.token), expiresAt: body.expiresAt, claimUrl: body.claimUrl, projectId: body.projectId, limits: body.limits }
  try {
    updateConfig((cfg) => {
      cfg.trials ??= {}
      cfg.trials[api] = { ...trial, savedAt: Date.now() }
      if (trial.projectId && !cfg.defaults?.[api]?.project && !cfg.sessions?.[api]) {
        cfg.defaults ??= {}
        cfg.defaults[api] = { project: trial.projectId, projectName: 'Trial sandbox' }
      }
    }, env)
  } catch {
    /* read-only config: the token is still printed */
  }
  return { ...trial, reused: false }
}

/** @type {Command} */
const tryCmd = {
  name: 'try',
  summary: 'Start a free anonymous trial: no sign-up, for you or your coding agent',
  usage: [
    'kadeep try [--new]',
    'Gets a short-lived KaDeep trial (a little AI credit, a sandbox project) and saves it on this machine, so',
    '`kadeep test` runs with no API key and `kadeep mcp` works at once. A person keeps the work with the claim link.',
    '--new starts a fresh trial instead of reusing the current one. KADEEP_TOKEN=<token> uses it elsewhere.'
  ],
  options: { new: { type: 'boolean' } },
  async run({ values, out, env, api }) {
    const t = await startTrial({ api, env, fresh: Boolean(values.new) })
    const { style } = out.ui
    out.result({ ok: true, ...t, api, next: ['npx kadeep test <url> "what to check"', 'npx kadeep mcp'] }, () => {
      out.line(`${style.ok('✓')} ${t.reused ? 'Your KaDeep trial is active' : 'KaDeep trial started'}${t.expiresAt ? style.muted(` · until ${new Date(t.expiresAt).toLocaleString()}`) : ''}${t.limits?.creditUsd ? style.muted(` · $${t.limits.creditUsd} of AI credit`) : ''}`)
      if (t.claimUrl) out.line(`  Keep your runs and get the full product: ${style.accent(t.claimUrl)}`)
      out.line('')
      out.line(`  ${style.accent('kadeep test http://localhost:3000 "sign up works"')}  ${style.muted('test any URL, localhost too')}`)
      out.line(`  ${style.accent('kadeep a11y http://localhost:3000')}                  ${style.muted('accessibility audit')}`)
    })
  }
}

export default [tryCmd]
