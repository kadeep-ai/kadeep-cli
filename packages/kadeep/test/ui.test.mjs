// The terminal UI layer: mode detection, palette, glyphs, the logo, dots, boxes, the live region and the prompts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { BACK, bigText, box, createKeys, createLive, createPrompts, createStyle, createUi, detectTerm, dotStrip, glyphs, header, KS_MARK, pad, parseKeys, strip, truncate, width, wrap } from '../src/ui/index.mjs'

/** A fake terminal stream that records what is written. */
function stream({ tty = true, columns = 80, depth = 24 } = {}) {
  const s = Object.assign(new EventEmitter(), { isTTY: tty, columns, out: '', getColorDepth: () => depth })
  s.write = (chunk) => ((s.out += chunk), true)
  return s
}
const fakeStdin = () => Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(v) { this.raw = v }, setEncoding() {}, resume() {}, pause() {} })
const term = (env = {}, o = {}) => detectTerm({ env, stdout: stream(o), stderr: stream(o), stdin: fakeStdin(), ...o.extra })
const ESC = /\u001b/

test('mode: rich only in a real terminal; plain in CI, pipes and dumb terminals; json wins; KADEEP_UI forces', () => {
  assert.equal(term({}).mode, 'rich')
  assert.equal(term({}).interactive, true)
  assert.equal(term({ CI: 'true' }).mode, 'plain')
  assert.equal(term({ GITHUB_ACTIONS: 'true' }).mode, 'plain')
  assert.equal(term({ GITLAB_CI: 'true' }).mode, 'plain')
  assert.equal(term({ TERM: 'dumb' }).mode, 'plain')
  assert.equal(term({}, { tty: false }).mode, 'plain')
  assert.equal(detectTerm({ env: {}, stdout: stream(), stderr: stream(), stdin: fakeStdin(), json: true }).mode, 'json')
  assert.equal(detectTerm({ env: { KADEEP_UI: 'rich' }, stdout: stream(), stderr: stream(), stdin: fakeStdin(), json: true }).mode, 'json', '--json beats KADEEP_UI')
  assert.equal(term({ KADEEP_UI: 'rich', CI: 'true' }, { tty: false }).mode, 'rich')
  assert.equal(term({ KADEEP_UI: 'plain' }).mode, 'plain')
})

test('color: truecolor / 256 / 16 from the terminal; none with NO_COLOR, --no-color, in plain mode; FORCE_COLOR wins', () => {
  assert.equal(term({}).color, 3)
  assert.equal(term({}, { depth: 8 }).color, 2)
  assert.equal(term({}, { depth: 4 }).color, 1)
  assert.equal(term({ NO_COLOR: '1' }).color, 0)
  assert.equal(term({ NO_COLOR: '' }).color, 3, 'an empty NO_COLOR does not count (per no-color.org)')
  assert.equal(detectTerm({ env: {}, stdout: stream(), stderr: stream(), stdin: fakeStdin(), noColor: true }).color, 0)
  assert.equal(term({ CI: 'true' }).color, 0, 'CI logs get no escape sequences')
  assert.equal(term({ CI: 'true', FORCE_COLOR: '1' }).color, 1)
  assert.equal(term({ FORCE_COLOR: '0' }).color, 0)
})

test('style: palette escapes by level, strip / width / truncate / pad by display width', () => {
  assert.equal(createStyle(0).accent('x'), 'x')
  assert.equal(createStyle(3).accent('x'), '\u001b[38;2;59;130;246mx\u001b[39m', 'testing blue #3b82f6')
  assert.equal(createStyle(3, { accent: 'loc' }).accent('x'), '\u001b[38;2;232;89;12mx\u001b[39m', 'localization orange #E8590C')
  assert.equal(createStyle(2).ok('x'), '\u001b[38;5;41mx\u001b[39m')
  assert.equal(createStyle(1).fail('x'), '\u001b[31mx\u001b[39m')
  const colored = createStyle(3).ok('passed')
  assert.equal(strip(colored), 'passed')
  assert.equal(width(colored), 6)
  assert.equal(width('日本'), 4, 'wide characters count 2')
  assert.equal(truncate('abcdefgh', 5), 'abcd…')
  assert.equal(strip(truncate(colored, 4)), 'pas…')
  assert.match(truncate(colored, 4), /\u001b\[0m$/, 'a cut colored string is reset')
  assert.equal(pad(colored, 8).length, colored.length + 2)
})

test('glyphs: unicode dots, ASCII fallbacks', () => {
  assert.equal(glyphs(true).dot, '●')
  assert.equal(glyphs(false).dot, '*')
  assert.doesNotMatch(Object.values(glyphs(false)).join(''), /[^\x20-\x7e]/, 'fallbacks are plain ASCII')
})

test('logo: the 66-dot KS mark beside up to 8 lines of text; text only below 60 columns', () => {
  assert.equal(KS_MARK.join('').replace(/\./g, '').length, 66)
  const ui = createUi({ env: {}, stdout: stream(), stderr: stream(), stdin: fakeStdin() })
  const lines = header(ui.term, ui.g, createStyle(0), [undefined, undefined, 'KaDeep Studios CLI'])
  assert.equal(lines.length, 8)
  assert.equal(lines[0], '● ●     ● ●     ● ● ● ● ●')
  assert.equal(lines[2], '● ● ● ●       ● ●            KaDeep Studios CLI')
  const narrow = createUi({ env: {}, stdout: stream({ columns: 50 }), stderr: stream({ columns: 50 }), stdin: fakeStdin() })
  assert.deepEqual(header(narrow.term, narrow.g, createStyle(0), [undefined, 'A', undefined, 'B']), ['A', 'B'])
})

test('dot font: 7 rows; GO and NO-GO read as intended', () => {
  const go = bigText('GO', glyphs(true))
  assert.equal(go.length, 7)
  assert.equal(go[0], '  ● ● ●       ● ● ●  ')
  assert.equal(bigText('NO-GO', glyphs(true))[3].includes('● ● ● ● ●'), true, 'the dash')
  assert.equal(bigText('?', glyphs(true))[0].trim(), '', 'unknown characters are blank')
})

test('dot strip: one dot per test, wraps at the width, compresses long suites, colors only with a palette', () => {
  const g = glyphs(true)
  const plain = createStyle(0)
  const states = [...Array(10).fill('passed'), 'failed', 'running', ...Array(8).fill('queued')]
  const { rows } = dotStrip(states, { columns: 24, g, style: plain })
  assert.deepEqual(rows.map((r) => r.split(' ').length), [12, 8])
  assert.equal(rows[1].split(' ').filter((d) => d === '○').length, 8)
  const big = dotStrip(Array.from({ length: 300 }, (_, i) => (i === 7 ? 'failed' : 'passed')), { columns: 40, maxRows: 2, g, style: createStyle(3) })
  assert.equal(big.perDot, 8)
  assert.equal(big.rows.length, 2)
  assert.match(big.rows[0], /\u001b\[38;2;239;68;68m●/, 'the bucket holding the failure shows red')
  assert.doesNotMatch(rows.join(''), ESC)
})

test('box: every line the same width, title in the border', () => {
  const lines = box(['short', 'a much longer line of text'], { columns: 80, g: glyphs(true), title: 'CI token' })
  assert.equal(new Set(lines.map(width)).size, 1)
  assert.match(lines[0], /^╭─ CI token ─+╮$/)
  assert.equal(width(box(['x'.repeat(200)], { columns: 40, g: glyphs(true) })[1]), 40, 'never wider than the terminal')
})

test('live region: hides the cursor, redraws in place, prints above, restores the cursor', () => {
  const out = stream()
  const err = stream()
  const t = detectTerm({ env: { KADEEP_UI: 'rich' }, stdout: out, stderr: err, stdin: fakeStdin() })
  const live = createLive(t)
  let n = 0
  live.start(() => [`frame ${n}`, 'second line'])
  n = 1
  live.update()
  live.print(['permanent'])
  live.stop()
  assert.match(err.out, /^\u001b\[\?25l/, 'cursor hidden first')
  assert.match(err.out, /\u001b\[2F\u001b\[J/, 'moves up over its 2 lines to redraw')
  assert.match(err.out, /frame 1/)
  assert.match(err.out, /\u001b\[\?25h$/, 'cursor shown last')
  assert.equal(out.out, 'permanent\n', 'printed lines go to stdout')
  assert.equal(process.listenerCount('SIGINT'), 0, 'its Ctrl-C handler is removed')
})

test('keys: arrows, enter, Ctrl-C, backspace, printable characters and pastes', () => {
  assert.deepEqual(parseKeys('\u001b[A\u001b[B\r'), ['up', 'down', 'enter'])
  assert.deepEqual(parseKeys('ab\u007f'), [{ char: 'a' }, { char: 'b' }, 'backspace'])
  assert.deepEqual(parseKeys('\u0003'), ['ctrl-c'])
  assert.deepEqual(parseKeys('é '), [{ char: 'é' }, 'space'])
  assert.deepEqual(parseKeys('\u001b[2~x'), [{ char: 'x' }], 'unknown sequences are skipped')
  assert.deepEqual(parseKeys('\u001b[Z\u001b[3~\u001b[H\u001b[F\u0015\u0017'), ['shift-tab', 'delete', 'home', 'end', 'ctrl-u', 'ctrl-w'])
})

test('wrap: by display width, never mid-word; long words cut; hanging indents; maxLines ends in …', () => {
  const text = 'The app entry page shows an "Acme Insurance" tenant picker with heading "Choose your organisation"'
  const lines = wrap(text, 30)
  assert.ok(lines.every((l) => width(l) <= 30))
  assert.equal(lines.join(' '), text, 'every word kept, in order')
  assert.ok(lines.every((l) => !/^\S+$/.test(l) || text.split(' ').includes(l)), 'no word is split')
  assert.deepEqual(wrap('one two three four', 11, { first: '• ', indent: '  ' }), ['• one two', '  three', '  four'])
  assert.deepEqual(wrap('https://example.com/a/very/long/path', 12), ['https://exam', 'ple.com/a/ve', 'ry/long/path'])
  assert.deepEqual(wrap('日本語のテキスト', 6), ['日本語', 'のテキ', 'スト'], 'wide characters count 2')
  const cut = wrap('alpha beta gamma delta epsilon', 12, { maxLines: 2 })
  assert.equal(cut.length, 2)
  assert.match(cut[1], /…$/)
  assert.deepEqual(wrap('first\n\nsecond', 20), ['first', '', 'second'], 'paragraphs kept')
})

test('keys hub: only the newest handler hears a key; raw mode lasts while anyone listens', () => {
  const stdin = fakeStdin()
  const keys = createKeys(stdin)
  const heard = { a: [], b: [] }
  const offA = keys.push((k) => heard.a.push(k))
  assert.equal(stdin.raw, true)
  const offB = keys.push((k) => heard.b.push(k))
  stdin.emit('data', 'x')
  offB()
  stdin.emit('data', '\u001b')
  assert.deepEqual(heard, { a: ['escape'], b: [{ char: 'x' }] })
  offA()
  assert.equal(stdin.raw, false, 'raw mode off when nobody listens')
})

/** A rich UI whose stdin the test types into. */
function promptUi() {
  const stdin = fakeStdin()
  const err = stream()
  const ui = createUi({ env: { KADEEP_UI: 'rich' }, stdout: stream(), stderr: err, stdin })
  const type = (...keys) => keys.forEach((k, i) => setTimeout(() => stdin.emit('data', k), 5 * (i + 1)))
  return { ui, stdin, err, type, p: createPrompts(ui) }
}

test('select: type to filter, arrows, enter; the answered line stays', async () => {
  const { err, type, p, stdin } = promptUi()
  const options = ['Acme web', 'Acme mobile', 'KaDeep CLI demo', 'Kadeep AI', 'PayYou', 'Maps', 'Canva', 'Zomato'].map((label) => ({ label, value: label }))
  type('k', 'a', 'd', '\u001b[B', '\r')
  assert.equal(await p.select({ message: 'Project', options }), 'Kadeep AI')
  assert.match(strip(err.out), /● Project {2}Kadeep AI\n$/)
  assert.equal(stdin.raw, false, 'raw mode is switched off')
  assert.match(err.out, /\u001b\[\?25h$/, 'cursor restored')
})

test('Ctrl-C cancels any prompt with a clean terminal (exit 130)', async () => {
  const { type, p, stdin, err } = promptUi()
  type('\u0003')
  await assert.rejects(p.confirm({ message: 'Create a CI token?' }), (e) => e.code === 'cancelled' && e.exitCode === 130)
  assert.equal(stdin.raw, false)
  assert.match(strip(err.out), /cancelled\n$/)
})

test('confirm, multiselect, text (validated) and password (never echoed)', async () => {
  let { type, p } = promptUi()
  type('n')
  assert.equal(await p.confirm({ message: 'Replace it?' }), false)
  ;({ type, p } = promptUi())
  type('\u001b[B', ' ', '\r')
  assert.deepEqual(await p.multiselect({ message: 'Files', options: [{ label: 'a', value: 'a' }, { label: 'b', value: 'b' }, { label: 'c', value: 'c' }] }), ['a', 'c'])
  let err
  ;({ type, p, err } = promptUi())
  type('b', 'o', 'b', '\r', '@', 'x', '\r')
  assert.equal(await p.text({ message: 'Email', validate: (v) => (v.includes('@') ? undefined : 'Enter an email') }), 'bob@x')
  assert.match(strip(err.out), /Enter an email/)
  ;({ type, p, err } = promptUi())
  type('s', '3', 'c', 'r', '3', 't', '\r')
  assert.equal(await p.password({ message: 'Password' }), 's3cr3t')
  assert.doesNotMatch(err.out, /s3cr3t/, 'the password is never drawn')
  assert.match(strip(err.out), /Password {2}••••••/)
})

test('prompts refuse to run without an interactive terminal', async () => {
  const ui = createUi({ env: { CI: 'true' }, stdout: stream(), stderr: stream(), stdin: fakeStdin() })
  await assert.rejects(createPrompts(ui).confirm({ message: 'x' }), (e) => e.code === 'usage' && e.exitCode === 2)
})

test('pick: Esc on an empty filter resolves to BACK and erases the picker; select never does', async () => {
  const { type, p, err } = promptUi()
  type('\u001b')
  assert.equal(await p.pick({ message: 'Runs', options: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] }), BACK)
  assert.doesNotMatch(strip(err.out).split('\n').slice(-2).join('\n'), /Runs/, 'nothing left on screen')
  const second = promptUi()
  second.type('\u001b', '\r')
  assert.equal(await second.p.select({ message: 'Runs', options: [{ label: 'a', value: 1 }] }), 1)
})

/** Type into the command line and resolve with what it returns. */
async function commandLine(keys, opts = {}) {
  const { type, p, err } = promptUi()
  type(...keys)
  const palette = [{ name: 'runs', summary: 'recent runs' }, { name: 'run', summary: 'run a suite' }, { name: 'suites', summary: 'suites' }, { name: 'exit', summary: 'leave' }]
  const r = await p.command({ palette, search: (q) => (q.startsWith('che') ? [{ kind: 'test', label: 'Checkout heading', value: { kind: 'test', key: 'checkout' } }] : []), ...opts })
  return { r, err: strip(err.out) }
}

test('command line: / opens the palette (exact match first), tab completes, enter runs the highlighted one', async () => {
  let { r, err } = await commandLine(['/', 'r', 'u', 'n', '\r'])
  assert.deepEqual(r, { kind: 'command', text: '/run' }, 'exact name first')
  assert.match(err, /● \/run\s+run a suite/)
  ;({ r } = await commandLine(['/', 'r', 'u', '\u001b[B', '\r']))
  assert.deepEqual(r, { kind: 'command', text: '/run' }, '↓ moves in the palette')
  ;({ r } = await commandLine(['/', 's', 'u', '\t', '-', '-', 'x', '\r']))
  assert.deepEqual(r, { kind: 'command', text: '/suites --x' }, 'tab completes, then flags can follow')
})

test('command line: plain text goes on as text; ↓ picks a search match; history on ↑; shift+tab calls back', async () => {
  let { r } = await commandLine(['w', 'h', 'y', ' ', '?', '\r'])
  assert.deepEqual(r, { kind: 'text', text: 'why ?' })
  ;({ r } = await commandLine(['c', 'h', 'e', '\u001b[B', '\r']))
  assert.equal(r.kind, 'open')
  assert.deepEqual(r.value, { kind: 'test', key: 'checkout' })
  ;({ r } = await commandLine(['\u001b[A', '\r'], { history: ['older', 'last thing'] }))
  assert.deepEqual(r, { kind: 'text', text: 'last thing' })
  let shifted = 0
  ;({ r } = await commandLine(['\u001b[Z', '\u001b[Z', 'x', '\r'], { onShiftTab: () => shifted++ }))
  assert.equal(shifted, 2)
  ;({ r } = await commandLine(['a', 'b', '\u001b[D', '\u001b[D', 'X', '\u0005', 'Y', '\r']))
  assert.deepEqual(r, { kind: 'text', text: 'XabY' }, 'cursor keys edit mid-line')
})

test('command line: Ctrl-C clears the line, twice on an empty line exits; Ctrl-D exits', async () => {
  let { r, err } = await commandLine(['a', 'b', '\u0003', '\u0003', '\u0003'])
  assert.deepEqual(r, { kind: 'exit' })
  assert.match(err, /Press Ctrl-C again to exit/)
  ;({ r } = await commandLine(['\u0004']))
  assert.deepEqual(r, { kind: 'exit' })
})
