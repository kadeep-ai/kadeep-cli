// @ts-check
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DEFAULT_API = 'https://api.kadeep.ai'

/**
 * @typedef {{ accessToken: string, refreshToken: string, user?: { id: string, email: string, name?: string }, savedAt?: number }} Session
 * @typedef {{ api?: string, sessions?: Record<string, Session>, defaults?: Record<string, { project?: string }> }} Config
 */

/** Where credentials live: $KADEEP_CONFIG_DIR, then $XDG_CONFIG_HOME/kadeep, %APPDATA%\kadeep on Windows, ~/.config/kadeep. */
export function configDir(env = process.env) {
  if (env.KADEEP_CONFIG_DIR) return env.KADEEP_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'kadeep')
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'kadeep')
  return join(homedir(), '.config', 'kadeep')
}

export const configPath = (env = process.env) => join(configDir(env), 'config.json')

/** @returns {Config} */
export function loadConfig(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Atomic, owner-only write: tokens never sit in a half-written or world-readable file.
 * @param {Config} cfg
 */
export function saveConfig(cfg, env = process.env) {
  const file = configPath(env)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    /* not supported on this filesystem */
  }
}

/** @param {string} url */
export const normalizeApi = (url) => url.trim().replace(/\/+$/, '')

/**
 * The API a command talks to: --api, KADEEP_API (or TESTSTUDIOS_API), the one you last logged in to, production.
 * @param {{ flag?: string, env?: NodeJS.ProcessEnv, config?: Config }} [input]
 */
export function resolveApi({ flag, env = process.env, config = loadConfig(env) } = {}) {
  return normalizeApi(flag || env.KADEEP_API || env.TESTSTUDIOS_API || config.api || DEFAULT_API)
}

/**
 * Read-modify-write on the freshest copy, so another kadeep process's refreshed tokens are not overwritten.
 * @param {(cfg: Config) => void} mutate
 * @returns {Config}
 */
export function updateConfig(mutate, env = process.env) {
  const next = loadConfig(env)
  mutate(next)
  saveConfig(next, env)
  return next
}
