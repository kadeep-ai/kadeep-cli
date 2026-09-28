// @ts-check
import { ciContext } from '../ci-env.mjs'
import { EXIT, usage } from '../errors.mjs'
import { duration } from '../output.mjs'
import { locPull, locPush, locStatus, locValidate } from '../ops/loc.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @type {Command} */
const loc = {
  name: 'loc',
  summary: 'Localization: push sources, pull approved translations, status, quality gate',
  usage: [
    'kadeep loc push --file <path> [--translate] [--ref <branch>] [--commit <sha>]',
    'kadeep loc pull --asset <name|id> --locale <tag> [--out <path>] [--format xliff|tmx]',
    'kadeep loc status',
    'kadeep loc validate [--locale <tag> …] [--min-coverage <pct>] [--min-mqm <n>] [--allow-unapproved]',
    'Uses the project\'s CI token (KADEEP_CI_TOKEN) and --project <id>, like `teststudios loc`. pull exits 4 while a delivery is not approved.'
  ],
  options: {
    file: { type: 'string' },
    translate: { type: 'boolean' },
    ref: { type: 'string' },
    commit: { type: 'string' },
    asset: { type: 'string' },
    locale: { type: 'string', multiple: true },
    out: { type: 'string' },
    format: { type: 'string' },
    'min-coverage': { type: 'string' },
    'min-mqm': { type: 'string' },
    'allow-unapproved': { type: 'boolean' }
  },
  async run({ values, positionals, out, client, project, env, num }) {
    const sub = positionals[0]
    if (!['push', 'pull', 'status', 'validate'].includes(sub ?? '')) throw usage('Usage: kadeep loc push|pull|status|validate (see kadeep loc --help)')
    const c = client('ci')
    const p = (await project(c)).id
    const started = Date.now()
    if (sub === 'push') {
      const ci = ciContext(env, { git: false })
      const r = await locPush(c, { project: p, file: values.file, translate: values.translate, ref: values.ref ?? (ci.ci ? ci.branch : undefined), commit: values.commit ?? (ci.ci ? ci.commit : undefined) })
      out.result(r, () => {
        if (r.unchanged) out.note(r.message ?? 'Nothing to push')
        else out.line(`pushed ${r.file} → asset ${r.assetId} v${r.version} (ingest job ${r.jobId})${r.translate ? ' · translation queued' : ''} in ${duration(Date.now() - started)}`)
      })
      return EXIT.OK
    }
    if (sub === 'pull') {
      const locales = values.locale ?? []
      if (locales.length > 1) throw usage('Pass one --locale for pull')
      const r = await locPull(c, { project: p, asset: values.asset, locale: locales[0], format: values.format, out: values.out })
      out.result(r, () => out.line(`pulled ${r.name} (${r.bytes} bytes${r.sha256 ? `, sha256 ${r.sha256.slice(0, 12)}…` : ''}) → ${r.out}`))
      return EXIT.OK
    }
    if (sub === 'status') {
      const s = await locStatus(c, { project: p })
      out.result(s, () => {
        out.line(`coverage ${s.coveragePct}% · MQM ${s.mqm ?? '—'}`)
        for (const l of s.locales) out.line(`${String(l.locale).padEnd(10)} coverage ${String(l.coveragePct).padStart(3)}%  readiness ${String(l.readiness).padStart(3)} ${l.status}${l.openCritical ? `  ⚠ ${l.openCritical} critical` : ''}`)
        for (const d of s.deliveries) out.line(`  ${String(d.locale).padEnd(8)} ${String(d.state).padEnd(12)} ${d.fileName ?? ''} ${d.checksum ? String(d.checksum).slice(0, 12) : ''}`)
      })
      return EXIT.OK
    }
    const v = await locValidate(c, { project: p, locales: values.locale, minCoverage: num('min-coverage'), minMqm: num('min-mqm'), allowUnapproved: values['allow-unapproved'] })
    out.result(v, () => {
      for (const f of v.failures) out.line(`${out.c.red('✗')} ${f}`)
      if (v.ok) out.line(`${out.c.green('✓')} ${v.locales.join(', ')} ready in ${duration(Date.now() - started)}`)
    })
    return v.ok ? EXIT.OK : EXIT.FAILED
  }
}

export default [loc]
