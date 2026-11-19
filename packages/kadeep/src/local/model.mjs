// @ts-check
import { loadConfig } from '../config.mjs'
import { EXIT, KadeepError } from '../errors.mjs'
import { USER_AGENT } from '../http.mjs'

export const DEFAULT_MODEL = 'claude-opus-5-5'

/** Server-side refusal fallback on the Claude API: a declined turn is re-run on a fallback model inside the same call. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

/**
 * @typedef {{ provider: 'anthropic' | 'kadeep', model: string, create: (params: Record<string, unknown>) => Promise<any> }} Model
 */

/** What to tell a person, or an agent, when there is no model to run on. */
export const NO_MODEL_HINT = [
  'The local test runner needs a model. Any one of these works:',
  '  export ANTHROPIC_API_KEY=sk-ant-...      your own Anthropic key (or `ant auth login`)',
  '  npx kadeep try                           a free, anonymous KaDeep trial (no sign-up, no key)',
  '  npx kadeep login                         your KaDeep account: tests run on KaDeep\'s plan',
  'Free account: https://kadeep.ai/start'
].join('\n')

/**
 * The KaDeep token the local runner may use for KaDeep's plan: KADEEP_TOKEN, a login, or a `kadeep try` trial.
 * @param {{ api: string, env: NodeJS.ProcessEnv, config?: import('../config.mjs').Config }} ctx
 */
export function kadeepModelToken({ api, env, config = loadConfig(env) }) {
  if (env.KADEEP_TOKEN) return { token: env.KADEEP_TOKEN, kind: 'token' }
  const s = config.sessions?.[api]
  if (s?.accessToken) return { token: s.accessToken, kind: 'session' }
  const t = config.trials?.[api]
  if (t?.token && (!t.expiresAt || Date.parse(t.expiresAt) > Date.now())) return { token: t.token, kind: 'try', claimUrl: t.claimUrl }
  return undefined
}

/**
 * Pick the model. --provider wins; otherwise your own Anthropic credentials (ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN),
 * then KaDeep's plan when you are signed in or on a trial, then an `ant auth login` profile if the SDK finds one.
 * @param {{ Anthropic: any, api: string, env: NodeJS.ProcessEnv, provider?: string, model?: string, effort?: string }} opts
 * @returns {Model}
 */
export function createModel({ Anthropic, api, env, provider, model, effort = 'medium' }) {
  if (provider && !['anthropic', 'kadeep'].includes(provider)) throw new KadeepError('--provider must be anthropic or kadeep', { code: 'usage', exitCode: EXIT.USAGE })
  const hasAnthropicEnv = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN)
  const kd = kadeepModelToken({ api, env })
  const pick = provider ?? (hasAnthropicEnv ? 'anthropic' : kd ? 'kadeep' : 'anthropic')
  const name = model || env.KADEEP_MODEL || DEFAULT_MODEL
  const output_config = { effort }

  if (pick === 'kadeep') {
    if (!kd) throw new KadeepError(`--provider kadeep needs a KaDeep sign-in.\n${NO_MODEL_HINT}`, { code: 'model_required', exitCode: EXIT.USAGE })
    const client = new Anthropic({ baseURL: `${api}/api/agent-model`, authToken: kd.token, maxRetries: 2, defaultHeaders: { 'user-agent': USER_AGENT, 'x-kadeep-client': USER_AGENT } })
    return {
      provider: 'kadeep',
      model: name,
      create: async (params) => {
        try {
          return await client.messages.create({ model: name, output_config, ...params })
        } catch (err) {
          throw modelError(err, { provider: 'kadeep', claimUrl: kd.claimUrl })
        }
      }
    }
  }

  /** @type {any} */
  let client
  try {
    client = new Anthropic({ maxRetries: 2 })
  } catch (err) {
    throw new KadeepError(`${NO_MODEL_HINT}\n(${/** @type {Error} */ (err).message})`, { code: 'model_required', exitCode: EXIT.USAGE })
  }
  return {
    provider: 'anthropic',
    model: name,
    create: async (params) => {
      try {
        return await client.beta.messages.create({ model: name, output_config, betas: [FALLBACK_BETA], fallbacks: 'default', ...params })
      } catch (err) {
        throw modelError(err, { provider: 'anthropic' })
      }
    }
  }
}

/**
 * Turn an SDK error into a KadeepError an agent can act on.
 * @param {unknown} err
 * @param {{ provider: string, claimUrl?: string }} ctx
 */
export function modelError(err, { provider, claimUrl }) {
  const e = /** @type {any} */ (err)
  const status = e?.status
  const body = e?.error ?? {}
  const type = body?.error?.type ?? body?.type
  const said = body?.error?.message ?? e?.message ?? String(err)
  if (status === 402 || type === 'credit_exhausted') {
    const claim = body?.claimUrl ?? claimUrl
    return new KadeepError(`KaDeep trial credit is used up.${claim ? ` Claim this trial to keep going: ${claim}` : ' Upgrade at https://kadeep.ai/pricing'} (or set ANTHROPIC_API_KEY).`, { code: 'credit_exhausted', exitCode: EXIT.USAGE, status, details: claim ? { claimUrl: claim } : undefined })
  }
  if (status === 401 || status === 403) {
    return new KadeepError(provider === 'kadeep' ? `KaDeep rejected the sign-in for the model (${said}).\n${NO_MODEL_HINT}` : `Anthropic rejected the credentials (${said}).\n${NO_MODEL_HINT}`, { code: 'model_auth', exitCode: EXIT.USAGE, status })
  }
  if (status === 404 && provider === 'kadeep') return new KadeepError('This KaDeep API does not offer KaDeep\'s plan to the local runner yet. Set ANTHROPIC_API_KEY, or use --provider anthropic.', { code: 'model_unavailable', exitCode: EXIT.USAGE, status })
  if (status === 429) return new KadeepError(`The model is rate limited (${said}). Try again in a minute.`, { code: 'rate_limited', exitCode: EXIT.NETWORK, status })
  if (status && status >= 500) return new KadeepError(`The model failed (HTTP ${status}): ${said}`, { code: 'model_server', exitCode: EXIT.NETWORK, status })
  if (/credential|api key|apiKey|authToken|authentication/i.test(said) && !status) return new KadeepError(NO_MODEL_HINT, { code: 'model_required', exitCode: EXIT.USAGE })
  if (!status) return new KadeepError(`Could not reach the model: ${said}`, { code: 'model_unreachable', exitCode: EXIT.NETWORK })
  return new KadeepError(`The model refused the request (HTTP ${status}): ${said}`, { code: 'model_error', exitCode: EXIT.FAILED, status })
}
