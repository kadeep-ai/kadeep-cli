// @ts-check
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { routes } from '../api.mjs'
import { EXIT, KadeepError, usage } from '../errors.mjs'

/**
 * Localization over the project's CI token: the same four operations and exit codes as `teststudios loc`.
 * @typedef {import('../client.mjs').Client} Client
 */

/**
 * Upload a source file as a new asset version; `translate` also queues translation of empty segments.
 * @param {Client} client
 * @param {{ project: string, file: string, translate?: boolean, ref?: string, commit?: string }} opts
 */
export async function locPush(client, opts) {
  if (!opts.file) throw usage('Pass --file <path>')
  /** @type {Buffer} */
  let bytes
  try {
    bytes = readFileSync(opts.file)
  } catch (err) {
    throw usage(`Cannot read ${opts.file}: ${/** @type {Error} */ (err).message}`)
  }
  const res = await routes.ci.locPush(client, opts.project, bytes, basename(opts.file), { translate: opts.translate ? '1' : undefined, ref: opts.ref, commit: opts.commit })
  if (res?.ok === false) return { ok: true, unchanged: true, file: basename(opts.file), message: res.error ?? 'Nothing to push' }
  return { ok: true, file: basename(opts.file), assetId: res.assetId, version: res.version, jobId: res.jobId, translate: Boolean(opts.translate) }
}

/**
 * Download the approved export for an asset (name or id) and locale. Not approved yet → exit 4.
 * @param {Client} client
 * @param {{ project: string, asset: string, locale: string, format?: string, out?: string }} opts
 */
export async function locPull(client, opts) {
  if (!opts.asset || !opts.locale) throw usage('Pass --asset <name|id> and --locale <tag>')
  const res = await routes.ci.locPull(client, opts.project, { asset: opts.asset, locale: opts.locale, format: opts.format }).catch((err) => {
    if (err instanceof KadeepError && err.status === 409) throw new KadeepError(err.message, { code: 'not_ready', exitCode: EXIT.NOT_READY, status: 409 })
    throw err
  })
  const name = /filename="([^"]+)"/.exec(String(res.headers['content-disposition'] ?? ''))?.[1] ?? `${opts.asset}-${opts.locale}`
  const out = opts.out ?? name
  writeFileSync(out, res.body)
  const sha = res.headers['x-checksum-sha256']
  return { ok: true, name, out, bytes: res.body.length, sha256: typeof sha === 'string' ? sha : undefined }
}

/** @param {Client} client @param {{ project: string }} opts */
export async function locStatus(client, opts) {
  const s = await routes.ci.locStatus(client, opts.project)
  return { ok: true, coveragePct: s.coveragePct, mqm: s.mqm, locales: s.locales ?? [], deliveries: s.deliveries ?? [] }
}

/**
 * The localization quality gate: every requested locale approved, covered and free of critical flags.
 * @param {Client} client
 * @param {{ project: string, locales?: string[], minCoverage?: number, minMqm?: number, allowUnapproved?: boolean }} opts
 * @returns {Promise<{ ok: boolean, locales: string[], failures: string[] }>}
 */
export async function locValidate(client, opts) {
  const res = await routes.ci.locValidate(client, opts.project, { locale: opts.locales?.length ? opts.locales : undefined, minCoverage: opts.minCoverage, minMqm: opts.minMqm, requireApproved: opts.allowUnapproved ? '0' : undefined })
  return { ok: Boolean(res?.ok), locales: res?.locales ?? [], failures: res?.failures ?? [] }
}
