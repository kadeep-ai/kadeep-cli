// @ts-check
import http from 'node:http'
import https from 'node:https'
import { EXIT, KadeepError, VERSION } from './errors.mjs'

export const USER_AGENT = `kadeep/${VERSION} (node ${process.version}; ${process.platform})`

/**
 * @typedef {{ status: number, headers: http.IncomingHttpHeaders, body: Buffer, text: () => string, json: () => any }} HttpResponse
 * @typedef {{ method?: string, headers?: Record<string, string>, body?: unknown, timeoutMs?: number, signal?: AbortSignal, userAgent?: string }} HttpOptions
 */

/**
 * One HTTP request over node:http(s). Not fetch: undici gives up on response headers after 300 s, and a CI call to an
 * older KaDeep API only answers when the whole suite is done. `timeoutMs` bounds the entire request instead.
 * Objects are sent as JSON; Buffers and strings as they are.
 * @param {string} url
 * @param {HttpOptions} [opts]
 * @returns {Promise<HttpResponse>}
 */
export function request(url, opts = {}) {
  const target = new URL(url)
  const lib = target.protocol === 'https:' ? https : http
  /** @type {Record<string, string>} */
  const headers = { 'user-agent': opts.userAgent ?? USER_AGENT, accept: 'application/json', ...opts.headers }
  /** @type {Buffer | undefined} */
  let payload
  if (opts.body !== undefined && opts.body !== null) {
    if (Buffer.isBuffer(opts.body)) payload = opts.body
    else if (typeof opts.body === 'string') payload = Buffer.from(opts.body)
    else {
      payload = Buffer.from(JSON.stringify(opts.body))
      headers['content-type'] ??= 'application/json'
    }
    headers['content-length'] = String(payload.length)
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(target, { method: opts.method ?? 'GET', headers }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('error', (err) => fail(err))
      res.on('end', () => {
        clearTimeout(timer)
        const body = Buffer.concat(chunks)
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body,
          text: () => body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8'))
        })
      })
    })
    const timer = opts.timeoutMs ? setTimeout(() => req.destroy(new KadeepError(`${target.origin} did not answer within ${Math.round((opts.timeoutMs ?? 0) / 1000)}s`, { code: 'timeout', exitCode: EXIT.NETWORK })), opts.timeoutMs) : undefined
    /** @param {Error & { code?: string }} err */
    function fail(err) {
      clearTimeout(timer)
      if (err instanceof KadeepError) return reject(err)
      if (opts.signal?.aborted) return reject(new KadeepError('Cancelled', { code: 'cancelled', exitCode: EXIT.FAILED }))
      reject(new KadeepError(`Could not reach ${target.origin}: ${err.code ?? err.message}`, { code: 'network', exitCode: EXIT.NETWORK }))
    }
    req.on('error', fail)
    opts.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true })
    if (payload) req.write(payload)
    req.end()
  })
}
