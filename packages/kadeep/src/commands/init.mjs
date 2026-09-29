// @ts-check
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { resolveProject, routes } from '../api.mjs'
import { EXIT, KadeepError, usage } from '../errors.mjs'
import { createCiToken } from '../ops/ci-token.mjs'
import { applyWrites, detectCi, planInit } from '../ops/init.mjs'
import { choose, confirm, interactive, richPrompts } from '../prompt.mjs'
import { box, header } from '../ui/index.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

const hasGh = () => spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0

/** @type {Command} */
const init = {
  name: 'init',
  summary: 'Set up this repo: releasegate policy, CI workflow, agent config',
  usage: [
    'kadeep init                                  # interactive',
    'kadeep init --yes --project <p> --suite <key> [--ci github|none] [--no-mcp] [--no-ci-token] [--force] [--dir <path>]',
    'Writes releasegate.yml (mode: shadow), .github/workflows/releasegate.yml, .mcp.json, .cursor/mcp.json and a',
    '.gitignore line. Existing files are left alone without --force. Creates the project\'s CI token only if it has none.'
  ],
  options: {
    suite: { type: 'string' },
    ci: { type: 'string' },
    'no-mcp': { type: 'boolean' },
    'no-ci-token': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    force: { type: 'boolean' },
    dir: { type: 'string' }
  },
  async run({ values, out, client, api, env, config }) {
    const dir = resolve(values.dir ?? '.')
    if (!existsSync(dir)) throw usage(`No such directory: ${dir}`)
    if (values.ci && !['github', 'none'].includes(values.ci)) throw usage('--ci must be github or none')
    const ask = interactive() && !values.yes && !out.json
    // Rich terminals get the step-by-step wizard (arrow keys, filtering); everything else keeps the line prompts.
    const rp = ask ? richPrompts(out) : null
    const { style, g, term } = out.ui
    /** @param {string} label @param {string} value */
    const step = (label, value) => rp && out.note(`${style.ok(g.dot)} ${label}  ${style.accent(value)}`)
    if (rp) out.ui.term.stderr.write(`\n${header(term, g, style, [undefined, undefined, style.bold('Set up this repository'), style.muted(dir), undefined, style.muted('A releasegate policy, a CI workflow and agent config.'), style.muted(`KaDeep Studios · ${api}`)]).join('\n')}\n\n`)
    const c = client('user')

    /** @type {any[]} */
    const projects = await routes.projects(c)
    const ref = values.project || env.KADEEP_PROJECT || config.defaults?.[api]?.project
    /** @type {any} */
    let project
    if (ref || projects.length === 1 || !ask) {
      project = await resolveProject(c, { ref: values.project, env, config })
      step('Project', project.name)
    } else if (rp) project = await rp.select({ message: 'Project for this repo', options: projects.map((p) => ({ label: p.name, value: p, hint: [p.id, p.baseUrl].filter(Boolean).join('  ') })) })
    else project = await choose('Project for this repo', projects, (p) => `${p.name}  ${p.baseUrl ?? ''}  (${p.id})`)

    /** @type {any[]} */
    const suites = await routes.suites(c, project.id)
    /** @type {any} */
    let suite
    if (values.suite) {
      suite = suites.find((s) => s.key === values.suite || s.id === values.suite || s.name.toLowerCase() === String(values.suite).toLowerCase())
      if (!suite) throw new KadeepError(`No suite "${values.suite}" in ${project.name}. Suites: ${suites.map((s) => s.key).join(', ') || 'none'}`, { code: 'not_found', exitCode: EXIT.USAGE })
      step('Suite for releasegate', suite.name)
    } else if (suites.length) {
      const preferred = Math.max(0, suites.findIndex((s) => /smoke/i.test(`${s.key} ${s.name}`)))
      if (ask && suites.length > 1 && rp) suite = await rp.select({ message: 'Suite for releasegate to run', options: suites.map((s) => ({ label: s.name, value: s, hint: `${s.key} · ${s.flowIds?.length ?? 0} tests` })), initial: preferred })
      else if (ask && suites.length > 1) suite = await choose('Suite for releasegate to run', suites, (s) => `${s.name}  (${s.key}, ${s.flowIds?.length ?? 0} tests)`, preferred)
      else {
        suite = suites[preferred]
        step('Suite for releasegate', suite.name)
      }
    } else if (rp) out.note(`${style.warn(g.warn)} ${project.name} has no suites yet; the policy starts empty.`)
    const locales = project.kind === 'localization' || project.localization?.targetLocales?.length ? project.localization?.targetLocales ?? [] : []

    let ci = /** @type {'github' | 'none'} */ (values.ci ?? detectCi(dir))
    let mcp = !values['no-mcp']
    let ignore = true
    // The wizard lets you pick the files, unless flags already decided.
    if (rp && values.ci === undefined && !values['no-mcp']) {
      const picked = await rp.multiselect({
        message: 'Files to write',
        options: [
          { label: 'GitHub Actions workflow', value: 'ci', hint: '.github/workflows/releasegate.yml' },
          { label: 'MCP config for Claude Code and Cursor', value: 'mcp', hint: '.mcp.json · .cursor/mcp.json' },
          { label: 'Ignore the gate reports', value: 'ignore', hint: '.gitignore → .releasegate/' }
        ],
        initial: [...(ci === 'github' ? ['ci'] : []), 'mcp', 'ignore']
      })
      ci = picked.includes('ci') ? 'github' : 'none'
      mcp = picked.includes('mcp')
      ignore = picked.includes('ignore')
    }
    const files = applyWrites(planInit({ dir, api, project, suite: suite ? { key: suite.key, name: suite.name } : undefined, locales, ci, mcp, force: Boolean(values.force), gitignore: ignore }))

    /** @type {{ status: 'created' | 'exists' | 'skipped', token?: string, secretSet?: boolean }} */
    let ciToken = { status: project.ciToken ? 'exists' : 'skipped' }
    const yes = (/** @type {string} */ q) => (rp ? rp.confirm({ message: q, initial: true }) : confirm(q, true))
    if (!project.ciToken && !values['no-ci-token'] && (!ask || (await yes(`Create a CI token for ${project.name}?`)))) {
      const created = await createCiToken(c, project)
      ciToken = { status: 'created', token: created.token }
      if (ask && ci === 'github' && hasGh() && (await yes('Store it as the KADEEP_CI_TOKEN secret of this GitHub repo with `gh secret set`?'))) {
        ciToken.secretSet = spawnSync('gh', ['secret', 'set', 'KADEEP_CI_TOKEN'], { cwd: dir, input: created.token, stdio: ['pipe', 'inherit', 'inherit'] }).status === 0
      }
    }

    const next = [
      ...(ciToken.status === 'created' && !ciToken.secretSet ? ['Add the CI token above as the repository secret KADEEP_CI_TOKEN (GitHub: gh secret set KADEEP_CI_TOKEN).'] : []),
      ...(ciToken.status === 'exists' ? ['This project already has a CI token: reuse it as the KADEEP_CI_TOKEN secret (`kadeep ci-token create --yes` replaces it).'] : []),
      ...(suite ? [] : ['Create a suite in KaDeep and add it under checks: in releasegate.yml.']),
      ...(ci === 'none' ? ['In your CI, run: KADEEP_CI_TOKEN=<secret> npx -y releasegate'] : []),
      'Commit the new files. The gate starts in shadow mode (reports, never blocks); set mode: enforce in releasegate.yml when ready.'
    ]
    const data = { ok: true, dir, project: { id: project.id, name: project.name }, suite: suite ? { key: suite.key, name: suite.name } : null, ci, files, ciToken, next }

    if (out.rich) {
      out.result(data, () => {
        const mark = (/** @type {string} */ a) => (a === 'skipped' ? style.warn(g.warn) : a === 'unchanged' ? style.muted(g.hollow) : style.ok(g.ok))
        out.lines(['', ...files.map((f) => `  ${mark(f.action)} ${relative(dir, f.path) || f.path}  ${style.muted(f.reason ?? f.action)}`)])
        if (ciToken.status === 'created')
          out.lines(['', ...box([style.bold(String(ciToken.token)), style.muted(ciToken.secretSet ? `${g.ok} saved as the KADEEP_CI_TOKEN repository secret` : 'next: gh secret set KADEEP_CI_TOKEN')], { columns: term.columns, g, title: 'CI token · shown once', border: style.accent })])
        out.lines(['', ...next.map((n) => `  ${style.muted(g.small)} ${n}`), '', `${style.muted(`${g.small} ${g.small} ${g.small}`)}  ${style.ok('Done.')} The gate starts in shadow mode.`])
      })
      return EXIT.OK
    }
    out.result(data, () => {
      out.line(`KaDeep init for ${project.name} (${project.id})${suite ? `, gate suite ${suite.key}` : ''}`)
      for (const f of files) out.line(`  ${f.action === 'skipped' ? out.c.yellow('skipped') : f.action === 'unchanged' ? out.c.dim('unchanged') : out.c.green(f.action)}  ${relative(dir, f.path) || f.path}${f.reason ? out.c.dim(`  (${f.reason})`) : ''}`)
      if (ciToken.status === 'created') {
        out.line()
        out.line(`CI token for ${project.name} (shown once):`)
        out.line(`  ${ciToken.token}`)
        if (ciToken.secretSet) out.line(`${out.c.green('✓')} Saved as the KADEEP_CI_TOKEN repository secret`)
      }
      out.line()
      out.line('Next:')
      for (const n of next) out.line(`  - ${n}`)
    })
    return EXIT.OK
  }
}

export default [init]
