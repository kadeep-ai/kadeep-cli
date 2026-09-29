// @ts-check
import { listRuns, listSuites, listTests } from '../ops/browse.mjs'
import { ago } from '../views/details.mjs'

/**
 * What typing at the session's prompt searches: the project's test cases, suites and recent runs, loaded once in the
 * background and refreshed after runs. Every word typed must appear in an item's name, key or id.
 *
 * @typedef {{ kind: 'test' | 'suite' | 'run', label: string, hint: string, hay: string, name: string, value: { kind: 'test' | 'suite' | 'run', id: string, key?: string, name: string, item: any } }} Item
 */

const KIND_ORDER = { suite: 0, test: 1, run: 2 }

/**
 * @param {import('../output.mjs').Output} out
 * @param {() => import('../client.mjs').Client} client
 * @param {() => string | undefined} project
 */
export function createIndex(out, client, project) {
  /** @type {Item[]} */
  let items = []
  /** @type {string | undefined} */
  let loadedFor

  async function load() {
    const p = project()
    if (!p) return (items = [])
    const c = client()
    const [tests, suites, runs] = await Promise.all([listTests(c, p), listSuites(c, p), listRuns(c, p, { limit: 50 })])
    loadedFor = p
    items = [
      ...suites.map((s) => /** @type {Item} */ ({ kind: 'suite', label: s.name, name: s.name, hint: `${s.tests} test${s.tests === 1 ? '' : 's'} · ${s.key}`, hay: `${s.name} ${s.key} ${s.id} ${s.labels.join(' ')}`.toLowerCase(), value: { kind: 'suite', id: s.id, key: s.key, name: s.name, item: s } })),
      ...tests.map((t) => /** @type {Item} */ ({ kind: 'test', label: t.name, name: t.name, hint: [t.lastRunStatus ?? 'never run', t.key].join(' · '), hay: `${t.name} ${t.key} ${t.id} ${t.labels.join(' ')}`.toLowerCase(), value: { kind: 'test', id: t.id, key: t.key, name: t.name, item: t } })),
      ...runs.map((r) => /** @type {Item} */ ({ kind: 'run', label: `${out.mark(r.status)} ${r.test}`, name: r.test, hint: [r.verdict && r.verdict !== 'PASS' ? r.verdict : r.status, ago(r.startedAt)].filter(Boolean).join(' · '), hay: `${r.test} ${r.id} ${r.verdict ?? ''}`.toLowerCase(), value: { kind: 'run', id: r.id, name: r.test, item: r } }))
    ]
    return items
  }

  let loading = Promise.resolve(/** @type {Item[]} */ ([]))
  return {
    /** Reload in the background (errors are ignored: search just finds less). */
    refresh() {
      loading = load().catch(() => items)
      return loading
    },
    /** Everything loaded, once loading has finished. */
    async all() {
      if (loadedFor !== project()) await this.refresh()
      return loading
    },
    /**
     * @param {string} text
     * @param {number} [limit]
     * @returns {Item[]}
     */
    search(text, limit = 50) {
      const q = text.toLowerCase().trim()
      const words = q.split(/\s+/).filter(Boolean)
      if (!words.length) return []
      /** @type {Set<string>} */
      const seenRunNames = new Set()
      return items
        .filter((x) => words.every((w) => x.hay.includes(w)))
        .map((x) => {
          const name = x.name.toLowerCase()
          const rank = name.startsWith(q) ? 0 : name.split(/\W+/).some((part) => part.startsWith(words[0])) ? 1 : 2
          return { x, rank }
        })
        .sort((a, b) => a.rank - b.rank || KIND_ORDER[a.x.kind] - KIND_ORDER[b.x.kind])
        .map(({ x }) => x)
        .filter((x) => {
          // One run per test: the latest (runs are newest first).
          if (x.kind !== 'run') return true
          if (seenRunNames.has(x.name)) return false
          seenRunNames.add(x.name)
          return true
        })
        .slice(0, limit)
    }
  }
}
