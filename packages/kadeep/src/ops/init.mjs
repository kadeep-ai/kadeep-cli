// @ts-check
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_API } from '../config.mjs'
import { VERSION } from '../errors.mjs'

/**
 * `kadeep init`: the files a customer repo needs for the KaDeep Release Gate and for coding agents. Pure planning
 * plus one apply step, so the command, tests and agents see the same list of writes. Nothing is overwritten unless
 * `force` is set; JSON config files are merged, not replaced.
 * @typedef {{ path: string, action: 'created' | 'updated' | 'unchanged' | 'skipped', reason?: string, content?: string }} FileWrite
 */

/** The version range init writes into CI and MCP configs: this minor line, so a breaking 0.x release is opt-in. */
export const RANGE = `^${VERSION.split('.').slice(0, 2).join('.')}`

/** @param {string[]} args @param {string} cwd */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000, encoding: 'utf8' }).trim() || undefined
  } catch {
    return undefined
  }
}

/** The branch releases come from: origin's HEAD, else main. @param {string} dir */
export function defaultBranch(dir) {
  return git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], dir)?.replace(/^origin\//, '') ?? 'main'
}

/** GitHub Actions if the repo already has .github/ or a GitHub remote. @param {string} dir */
export function detectCi(dir) {
  if (existsSync(join(dir, '.github'))) return 'github'
  return /github\.com/.test(git(['remote', 'get-url', 'origin'], dir) ?? '') ? 'github' : 'none'
}

/**
 * @param {{ project: { id: string, name?: string }, suite?: { key: string, name: string }, locales?: string[] }} input
 */
export function policyYaml({ project, suite, locales }) {
  const checks = []
  if (suite) checks.push(`  - name: ${JSON.stringify(suite.name)}\n    suite: ${suite.key}`)
  if (locales?.length) checks.push(`  - name: Localization ready\n    localization:\n      locales: [${locales.join(', ')}]\n      minCoverage: 100`)
  return [
    '# KaDeep Release Gate policy: which KaDeep checks decide go / no-go for a commit.',
    '# Engineering release confidence. Reference: https://www.npmjs.com/package/releasegate',
    'version: 1',
    `project: ${project.id}${project.name ? `  # ${project.name}` : ''}`,
    '# shadow: run every check and write the report, but never fail the build.',
    '# enforce: a NO-GO fails the build. Switch once the gate has been green for a while.',
    'mode: shadow',
    checks.length ? 'checks:' : 'checks: []  # add a suite, e.g.  - suite: smoke',
    ...checks,
    'report:',
    '  dir: .releasegate',
    ''
  ].join('\n')
}

/** @param {{ branch: string, api: string }} input */
export function workflowYaml({ branch, api }) {
  return [
    '# KaDeep Release Gate: go / no-go on every pull request and release-branch push.',
    '# Needs the repository secret KADEEP_CI_TOKEN (`kadeep ci-token create`). Policy: releasegate.yml',
    'name: KaDeep Release Gate',
    '',
    'on:',
    '  pull_request:',
    '  push:',
    `    branches: [${branch}]`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'jobs:',
    '  releasegate:',
    '    name: KaDeep Release Gate',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 45',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          node-version: 22',
    '      - name: Release gate',
    `        run: npx -y releasegate@${RANGE}`,
    '        env:',
    '          KADEEP_CI_TOKEN: ${{ secrets.KADEEP_CI_TOKEN }}',
    ...(api !== DEFAULT_API ? [`          KADEEP_API: ${api}`] : []),
    '      - name: Upload the gate report',
    '        if: always()',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: releasegate-report',
    '          path: .releasegate/',
    '          if-no-files-found: ignore',
    ''
  ].join('\n')
}

/** The MCP server entry for Claude Code (.mcp.json) and Cursor (.cursor/mcp.json). @param {{ project: string, api: string }} input */
export function mcpEntry({ project, api }) {
  return { command: 'npx', args: ['-y', `kadeep@${RANGE}`, 'mcp'], env: { KADEEP_PROJECT: project, ...(api !== DEFAULT_API ? { KADEEP_API: api } : {}) } }
}

/**
 * @param {string} file
 * @param {string} content
 * @param {boolean} force
 * @returns {FileWrite}
 */
function plainFile(file, content, force) {
  if (!existsSync(file)) return { path: file, action: 'created', content }
  if (readFileSync(file, 'utf8') === content) return { path: file, action: 'unchanged' }
  return force ? { path: file, action: 'updated', content } : { path: file, action: 'skipped', reason: 'exists (use --force to overwrite)' }
}

/**
 * @param {string} file
 * @param {object} entry
 * @param {boolean} force
 * @returns {FileWrite}
 */
function mcpFile(file, entry, force) {
  /** @type {any} */
  let json = {}
  if (existsSync(file)) {
    try {
      json = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return { path: file, action: 'skipped', reason: 'not valid JSON; add the kadeep server by hand' }
    }
  }
  json.mcpServers ??= {}
  const had = json.mcpServers.kadeep
  if (had && JSON.stringify(had) === JSON.stringify(entry)) return { path: file, action: 'unchanged' }
  if (had && !force) return { path: file, action: 'skipped', reason: 'already has a kadeep server (use --force to replace it)' }
  json.mcpServers.kadeep = entry
  return { path: file, action: existsSync(file) ? 'updated' : 'created', content: `${JSON.stringify(json, null, 2)}\n` }
}

/** @param {string} file @returns {FileWrite} */
function gitignore(file) {
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  if (/^\/?\.releasegate\/?\s*$/m.test(current)) return { path: file, action: 'unchanged' }
  return { path: file, action: current ? 'updated' : 'created', content: `${current}${current && !current.endsWith('\n') ? '\n' : ''}# KaDeep Release Gate reports\n.releasegate/\n` }
}

/**
 * @param {{ dir: string, api: string, project: { id: string, name?: string }, suite?: { key: string, name: string }, locales?: string[], ci: 'github' | 'none', mcp: boolean, force: boolean, gitignore?: boolean }} input
 * @returns {FileWrite[]}
 */
export function planInit({ dir, api, project, suite, locales, ci, mcp, force, gitignore: ignore = true }) {
  /** @type {FileWrite[]} */
  const writes = [plainFile(join(dir, 'releasegate.yml'), policyYaml({ project, suite, locales }), force)]
  if (ci === 'github') writes.push(plainFile(join(dir, '.github/workflows/releasegate.yml'), workflowYaml({ branch: defaultBranch(dir), api }), force))
  if (mcp) {
    const entry = mcpEntry({ project: project.id, api })
    writes.push(mcpFile(join(dir, '.mcp.json'), entry, force), mcpFile(join(dir, '.cursor/mcp.json'), entry, force))
  }
  if (ignore) writes.push(gitignore(join(dir, '.gitignore')))
  return writes
}

/** @param {FileWrite[]} writes */
export function applyWrites(writes) {
  for (const w of writes) {
    if (w.content === undefined || w.action === 'skipped' || w.action === 'unchanged') continue
    mkdirSync(dirname(w.path), { recursive: true })
    writeFileSync(w.path, w.content)
  }
  return writes.map(({ content, ...rest }) => rest)
}
