// A stand-in KaDeep API for tests: route handlers per test, JSON in and out, and a request log.
import { createServer } from 'node:http'

/**
 * @param {Record<string, (req: { method: string, path: string, query: URLSearchParams, body: any, headers: import('node:http').IncomingHttpHeaders }) => [number, unknown] | ((res: import('node:http').ServerResponse) => void) | undefined>} routes
 *   keyed by "METHOD /path"; a handler returns [status, body], or a function that writes the response itself (streams)
 */
export async function fakeApi(routes) {
  /** @type {string[]} */
  const log = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x')
      const key = `${req.method} ${url.pathname}`
      log.push(key)
      const handler = routes[key]
      const out = handler?.({ method: req.method ?? 'GET', path: url.pathname, query: url.searchParams, body: raw ? JSON.parse(raw) : undefined, headers: req.headers })
      if (typeof out === 'function') return out(res)
      const [status, body] = out ?? [404, { ok: false, error: `no route ${key}` }]
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const address = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    url: `http://127.0.0.1:${address.port}`,
    log,
    close: () => new Promise((r) => server.close(() => r(undefined)))
  }
}

/** A handler that answers each call with the next item, repeating the last. @param {Array<[number, unknown]>} answers */
export function sequence(answers) {
  let i = 0
  return () => answers[Math.min(i++, answers.length - 1)]
}

/**
 * A streamed agent turn: each event goes out as a Server-Sent Event, `gapMs` apart, with a ping first.
 * @param {Array<Record<string, unknown> | number>} events  a number waits that many ms before the next event
 * @param {{ gapMs?: number }} [opts]
 */
export function sse(events, opts = {}) {
  return (/** @type {import('node:http').ServerResponse} */ res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    res.write(': ping\n\n')
    let i = 0
    const next = () => {
      if (res.writableEnded) return
      if (i >= events.length) return res.end()
      const e = events[i++]
      if (typeof e === 'number') return setTimeout(next, e)
      res.write(`data: ${JSON.stringify(e)}\n\n`)
      setTimeout(next, opts.gapMs ?? 5)
    }
    next()
  }
}
