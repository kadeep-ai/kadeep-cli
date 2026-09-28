// @ts-check
import { EXIT, usage } from '../errors.mjs'
import { createCiToken } from '../ops/ci-token.mjs'
import { confirm, interactive } from '../prompt.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @type {Command} */
const ciToken = {
  name: 'ci-token',
  summary: 'Create the project\'s CI token (used by `kadeep run` in CI, `kadeep loc` and releasegate)',
  usage: ['kadeep ci-token create [--yes]      # --yes replaces an existing token (pipelines using it stop working)'],
  options: { yes: { type: 'boolean', short: 'y' } },
  async run({ values, positionals, out, client, project }) {
    if (positionals[0] !== 'create') throw usage('Usage: kadeep ci-token create [--yes]')
    const c = client('user')
    const p = await project(c)
    let replace = Boolean(values.yes)
    if (p.ciToken && !replace && interactive() && !out.json) {
      out.warn(`${p.name} already has a CI token. A new one replaces it and every pipeline using the old one stops working.`)
      replace = await confirm('Replace it?', false)
      if (!replace) return EXIT.FAILED
    }
    const r = await createCiToken(c, p, { replace })
    out.result({ ok: true, project: { id: p.id, name: p.name }, token: r.token, replaced: r.replaced }, () => {
      out.line(`${out.c.green('✓')} ${r.replaced ? 'Replaced' : 'Created'} the CI token for ${p.name} (${p.id}). It is shown only once:`)
      out.line()
      out.line(`  ${r.token}`)
      out.line()
      out.line('Store it as a CI secret named KADEEP_CI_TOKEN, e.g. on GitHub:  gh secret set KADEEP_CI_TOKEN')
    })
    return EXIT.OK
  }
}

export default [ciToken]
