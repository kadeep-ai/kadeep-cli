// @ts-check

/**
 * Server-Sent Events → JSON objects. Feed it text as it arrives (chunks split events anywhere); it calls `onEvent`
 * for each complete `data:` event. Comments (the API's `: ping` heartbeats) and non-JSON data are skipped.
 * @param {(event: any) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buf = ''
  return {
    /** @param {string} text */
    push(text) {
      buf += text
      for (;;) {
        const m = /\r?\n\r?\n/.exec(buf)
        if (!m) return
        const block = buf.slice(0, m.index)
        buf = buf.slice(m.index + m[0].length)
        const data = block
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        if (!data) continue
        let event
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        onEvent(event)
      }
    }
  }
}
