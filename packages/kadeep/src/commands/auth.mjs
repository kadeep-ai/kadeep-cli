// @ts-check
import { routes } from '../api.mjs'
import { configPath, updateConfig } from '../config.mjs'
import { EXIT, KadeepError, usage } from '../errors.mjs'
import { request } from '../http.mjs'
import { ask, askHidden, interactive, readStdin } from '../prompt.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @type {Command} */
const login = {
  name: 'login',
  summary: 'Sign in with your KaDeep email and password',
  usage: ['kadeep login [--email <email>] [--password-stdin] [--api <url>]', 'echo "$PASSWORD" | kadeep login --email you@company.com --password-stdin'],
  options: { email: { type: 'string' }, 'password-stdin': { type: 'boolean' } },
  async run({ values, out, api, env }) {
    const email = values.email || env.KADEEP_EMAIL || (interactive() ? await ask('Email') : '')
    if (!email) throw usage('Pass --email <email>')
    const password = values['password-stdin'] ? await readStdin() : await askHidden('Password')
    if (!password) throw usage('No password given')
    const res = await request(`${api}/api/auth/login`, { method: 'POST', body: { email, password }, timeoutMs: 30_000 })
    const body = (() => {
      try {
        return res.json()
      } catch {
        return {}
      }
    })()
    if (res.status === 401 || res.status === 400) throw new KadeepError(body.error ?? 'Email or password is wrong', { code: 'auth_invalid', exitCode: EXIT.USAGE, status: res.status })
    if (res.status === 429) throw new KadeepError(body.error ?? 'Too many sign-in attempts; wait a minute and try again.', { code: 'rate_limited', exitCode: EXIT.NETWORK, status: 429 })
    if (res.status !== 200 || !body.accessToken) throw new KadeepError(`Sign-in failed (HTTP ${res.status})${body.error ? `: ${body.error}` : ''}`, { code: 'server', exitCode: EXIT.NETWORK, status: res.status })
    const user = { id: body.user?.id, email: body.user?.email ?? email, name: body.user?.name }
    updateConfig((cfg) => {
      cfg.api = api
      cfg.sessions ??= {}
      cfg.sessions[api] = { accessToken: body.accessToken, refreshToken: body.refreshToken, user, savedAt: Date.now() }
    }, env)
    out.result({ ok: true, api, user }, () => out.line(`${out.c.green('✓')} Logged in to ${api} as ${user.name ? `${user.name} <${user.email}>` : user.email}`))
  }
}

/** @type {Command} */
const logout = {
  name: 'logout',
  summary: 'Sign out on this machine (and end the session on KaDeep)',
  usage: ['kadeep logout'],
  async run({ out, api, env, config }) {
    const session = config.sessions?.[api]
    if (session?.accessToken) await request(`${api}/api/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${session.accessToken}` }, timeoutMs: 15_000 }).catch(() => null)
    updateConfig((cfg) => {
      if (cfg.sessions) delete cfg.sessions[api]
    }, env)
    out.result({ ok: true, api, wasLoggedIn: Boolean(session) }, () => out.line(session ? `Logged out of ${api}` : `Not logged in to ${api}`))
  }
}

/** @type {Command} */
const whoami = {
  name: 'whoami',
  summary: 'Show who you are signed in as, and where',
  usage: ['kadeep whoami'],
  async run({ out, api, env, config, client }) {
    const session = config.sessions?.[api]
    if (!env.KADEEP_TOKEN && !session) {
      if (env.KADEEP_CI_TOKEN || env.TESTSTUDIOS_CI_TOKEN) {
        out.result({ ok: true, api, auth: 'ci', user: null }, () => out.line(`Using a project CI token against ${api} (not signed in as a person)`))
        return
      }
      throw new KadeepError(`Not logged in to ${api}. Run \`kadeep login\`.`, { code: 'auth_required', exitCode: EXIT.USAGE })
    }
    const me = await routes.me(client('user'))
    const user = { id: me.id, email: me.email, name: me.name, role: me.role }
    out.result({ ok: true, api, auth: env.KADEEP_TOKEN ? 'token' : 'session', user, config: env.KADEEP_TOKEN ? undefined : configPath(env) }, () => out.line(`${user.name ? `${user.name} <${user.email}>` : user.email}${user.role ? ` · ${user.role}` : ''} on ${api}`))
  }
}

export default [login, logout, whoami]
