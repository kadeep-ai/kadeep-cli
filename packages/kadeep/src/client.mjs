// @ts-check
import { loadConfig, updateConfig } from './config.mjs'
import { EXIT, KadeepError } from './errors.mjs'
import { request } from './http.mjs'

/**
 * How a call is authenticated. A session is a login (refreshes itself); `token` is KADEEP_TOKEN (an access token,
 * never refreshed); `ci` is a project's CI token, which only the /api/ci/* routes accept.
 * @typedef {{ kind: 'session', accessToken: string, refreshToken: string } | { kind: 'token', token: string } | { kind: 'ci', token: string } | { kind: 'none' }} Auth
 * @typedef {{ query?: Record<string, unknown>, body?: unknown, headers?: Record<string, string>, raw?: boolean, timeoutMs?: number, signal?: AbortSignal, accept?: number[] }} CallOptions
 * @typedef {ReturnType<typeof createClient>} Client
 */

/** @param {string} api */
const notLoggedIn = (api) => new KadeepError(`Not logged in to ${api}. Run \`kadeep login\` (or set KADEEP_TOKEN).`, { code: 'auth_required', exitCode: EXIT.USAGE })
const noCiToken = () => new KadeepError('This needs the project\'s CI token: set KADEEP_CI_TOKEN (create one with `kadeep ci-token create`, or in the app under Settings → CI).', { code: 'ci_token_required', exitCode: EXIT.USAGE })

/**
 * Pick credentials for what a command needs. Sessions are stored per API, so a token is only ever sent to the host
 * that issued it.
 *   user: a person (login or KADEEP_TOKEN) · run: a person, else the CI token · ci: the CI token · any: whatever exists
 * @param {'user' | 'run' | 'ci' | 'any'} need
 * @param {{ api: string, env?: NodeJS.ProcessEnv, config?: import('./config.mjs').Config }} ctx
 * @returns {Auth}
 */
export function resolveAuth(need, { api, env = process.env, config = loadConfig(env) }) {
  const session = config.sessions?.[api]
  /** @type {Auth | null} */
  const person = env.KADEEP_TOKEN ? { kind: 'token', token: env.KADEEP_TOKEN } : session?.accessToken ? { kind: 'session', accessToken: session.accessToken, refreshToken: session.refreshToken } : null
  const ciToken = env.KADEEP_CI_TOKEN || env.TESTSTUDIOS_CI_TOKEN
  /** @type {Auth | null} */
  const ci = ciToken ? { kind: 'ci', token: ciToken } : null
  if (need === 'user') {
    if (person) return person
    throw notLoggedIn(api)
  }
  if (need === 'ci') {
    if (ci) return ci
    throw noCiToken()
  }
  if (need === 'run') {
    const pick = person ?? ci
    if (pick) return pick
    throw new KadeepError(`Not logged in to ${api} and no KADEEP_CI_TOKEN is set. Run \`kadeep login\`, or set KADEEP_CI_TOKEN in CI.`, { code: 'auth_required', exitCode: EXIT.USAGE })
  }
  return person ?? ci ?? { kind: 'none' }
}

/** @param {Record<string, unknown> | undefined} query */
function qs(query) {
  if (!query) return ''
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) for (const x of v) q.append(k, String(x))
    else q.set(k, String(v))
  }
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** @param {import('./http.mjs').HttpResponse} res */
function parse(res) {
  if (!res.body.length) return null
  const text = res.text()
  // The CI route and `?wait` suite runs pad with whitespace heartbeats; JSON.parse ignores leading whitespace.
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * @param {import('./http.mjs').HttpResponse} res
 * @param {Auth} auth
 * @param {string} api
 */
function toError(res, auth, api) {
  const body = parse(res)
  const said = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : typeof body === 'string' && body.length < 300 && !/<html/i.test(body) ? body : ''
  const status = res.status
  const details = body && typeof body === 'object' ? body : undefined
  if (status === 401) {
    if (auth.kind === 'session') return new KadeepError(`Your KaDeep session expired or was signed out. Run \`kadeep login\` again.`, { code: 'auth_required', exitCode: EXIT.USAGE, status })
    if (auth.kind === 'token') return new KadeepError('KADEEP_TOKEN was rejected (expired or revoked).', { code: 'auth_required', exitCode: EXIT.USAGE, status })
    if (auth.kind === 'ci') return new KadeepError(`The CI token was rejected${said ? ` (${said})` : ''}. Check KADEEP_CI_TOKEN and the project id.`, { code: 'auth_invalid', exitCode: EXIT.USAGE, status })
    return notLoggedIn(api)
  }
  if (status === 403) return new KadeepError(said || 'You do not have permission for that.', { code: 'forbidden', exitCode: EXIT.USAGE, status, details })
  if (status === 404) return new KadeepError(said || 'Not found.', { code: 'not_found', exitCode: EXIT.USAGE, status, details })
  if (status === 400) return new KadeepError(said || 'Bad request.', { code: 'bad_request', exitCode: EXIT.USAGE, status, details })
  if (status === 409) return new KadeepError(said || 'Conflict.', { code: 'conflict', exitCode: EXIT.FAILED, status, details })
  if (status === 429) return new KadeepError(said || 'Too many requests; try again in a minute.', { code: 'rate_limited', exitCode: EXIT.NETWORK, status, details })
  if (status === 524 || status === 504) return new KadeepError(`${api} took too long to answer (HTTP ${status}).`, { code: 'timeout', exitCode: EXIT.NETWORK, status })
  if (status >= 500) return new KadeepError(`KaDeep API error (HTTP ${status})${said ? `: ${said}` : ''}`, { code: 'server', exitCode: EXIT.NETWORK, status, details })
  return new KadeepError(said || `HTTP ${status}`, { code: 'http_error', exitCode: EXIT.FAILED, status, details })
}

/**
 * An authenticated KaDeep API client. Session auth refreshes once on a 401 and persists the rotated pair; before
 * refreshing it re-reads the config, because another kadeep process (the MCP server, a parallel command) may already
 * have rotated the refresh token.
 * @param {{ api: string, auth: Auth, env?: NodeJS.ProcessEnv, userAgent?: string }} opts
 */
export function createClient({ api, auth, env = process.env, userAgent }) {
  /** @type {Auth} */
  let current = auth
  const bearer = () => (current.kind === 'session' ? current.accessToken : current.kind === 'token' || current.kind === 'ci' ? current.token : undefined)

  /** @param {string} method @param {string} path @param {CallOptions} opts */
  function send(method, path, opts) {
    const token = bearer()
    return request(`${api}${path}${qs(opts.query)}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...opts.headers }, body: opts.body, timeoutMs: opts.timeoutMs ?? 60_000, signal: opts.signal, userAgent })
  }

  /** @param {{ accessToken: string, refreshToken: string }} t */
  const adopt = (t) => {
    current = { kind: 'session', accessToken: t.accessToken, refreshToken: t.refreshToken }
  }

  async function refresh() {
    if (current.kind !== 'session') return false
    const tried = current.refreshToken
    const onDisk = loadConfig(env).sessions?.[api]
    if (onDisk?.accessToken && onDisk.accessToken !== current.accessToken) {
      adopt(onDisk)
      return true
    }
    const res = await request(`${api}/api/auth/refresh`, { method: 'POST', body: { refreshToken: tried }, timeoutMs: 30_000, userAgent }).catch(() => null)
    if (res?.status === 200) {
      const t = res.json()
      adopt(t)
      try {
        updateConfig((cfg) => {
          cfg.sessions ??= {}
          const prev = cfg.sessions[api]
          cfg.sessions[api] = { ...prev, accessToken: t.accessToken, refreshToken: t.refreshToken, user: t.user ? { id: t.user.id, email: t.user.email, name: t.user.name } : prev?.user, savedAt: Date.now() }
        }, env)
      } catch {
        /* read-only config: the new pair still works for this process */
      }
      return true
    }
    // Lost a refresh race: the winner has written the new pair by now.
    const again = loadConfig(env).sessions?.[api]
    if (again?.refreshToken && again.refreshToken !== tried) {
      adopt(again)
      return true
    }
    return false
  }

  /**
   * @param {string} method
   * @param {string} path
   * @param {CallOptions} [opts]
   * @returns {Promise<any>}
   */
  async function call(method, path, opts = {}) {
    let res = await send(method, path, opts)
    if (res.status === 401 && current.kind === 'session' && (await refresh())) res = await send(method, path, opts)
    if ((res.status >= 200 && res.status < 300) || opts.accept?.includes(res.status)) return opts.raw ? res : parse(res)
    throw toError(res, current, api)
  }

  return {
    api,
    get auth() {
      return current
    },
    call,
    /** @param {string} path @param {CallOptions} [opts] */
    get: (path, opts) => call('GET', path, opts),
    /** @param {string} path @param {unknown} [body] @param {CallOptions} [opts] */
    post: (path, body, opts) => call('POST', path, { ...opts, body: body ?? {} })
  }
}
