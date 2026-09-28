#!/usr/bin/env node
/**
 * Tarball guard for `kadeep` and `releasegate`: only allowlisted files ship (bin, src, README, LICENSE), with no
 * references to KaDeep's private server code, no secrets, no .env files and no source maps. It reads the exact file
 * list `npm pack` would publish. Runs in CI and as each package's prepublishOnly.
 *
 *   node scripts/check-packs.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = { kadeep: { dir: 'packages/kadeep', deps: [] }, releasegate: { dir: 'packages/releasegate', deps: ['kadeep', 'yaml'] } }
const FILE_OK = /^(package\.json|README\.md|LICENSE|bin\/[\w.-]+\.mjs|src\/[\w./-]+\.mjs)$/
const FORBIDDEN = [
  [/@teststudios\//, 'references KaDeep server packages (@teststudios/*)'],
  [/\bapps\/(api|web|desktop|mobile)\b/, 'references KaDeep server code (apps/*)'],
  [/sourceMappingURL/, 'references a source map'],
  [/\bts_[0-9a-f]{48}\b/, 'contains a CI token'],
  [/sk-or-[\w-]{10,}/, 'contains an OpenRouter key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'contains a private key'],
  [/JWT_SECRET/, 'mentions a server secret'],
  [/mongodb(\+srv)?:\/\//, 'contains a database URL'],
  [/eyJhbGciOi[\w-]+\.[\w-]+\.[\w-]+/, 'contains a JWT'],
  [/AKIA[0-9A-Z]{16}/, 'contains an AWS access key']
]

const output = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', ...Object.values(PACKAGES).flatMap((p) => ['--workspace', p.dir])], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }))
// npm ≤ 11 prints an array, npm 12 an object keyed by package name.
const packed = Array.isArray(output) ? output : Object.values(output)
const problems = []
for (const [name, spec] of Object.entries(PACKAGES)) {
  const pack = packed.find((p) => p.name === name)
  if (!pack) {
    problems.push(`${name}: npm pack produced nothing`)
    continue
  }
  const pkg = JSON.parse(readFileSync(join(root, spec.dir, 'package.json'), 'utf8'))
  if (pkg.private) problems.push(`${name}: package.json is private`)
  if (pkg.license !== 'Apache-2.0') problems.push(`${name}: license is ${pkg.license}, expected Apache-2.0`)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) if (!spec.deps.includes(dep)) problems.push(`${name}: unexpected dependency ${dep}`)
  for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) if (/^(workspace|file|link):/.test(String(range))) problems.push(`${name}: dependency ${dep} uses a local specifier (${range})`)
  const readme = existsSync(join(root, spec.dir, 'README.md')) ? readFileSync(join(root, spec.dir, 'README.md'), 'utf8') : ''
  if (!readme) problems.push(`${name}: README.md is missing`)
  else if (!readme.includes('Engineering release confidence.')) problems.push(`${name}: README.md lacks the tagline "Engineering release confidence."`)
  console.log(`${name}@${pack.version}: ${pack.files.length} files, ${(pack.size / 1024).toFixed(1)} kB packed`)
  for (const f of pack.files) {
    console.log(`  ${f.path}`)
    if (!FILE_OK.test(f.path)) problems.push(`${name}: ${f.path} is not on the allowlist`)
    if (/\.map$|(^|\/)\.env|\.ts$/.test(f.path)) problems.push(`${name}: ${f.path} must not ship`)
    const text = readFileSync(join(root, spec.dir, f.path), 'utf8')
    for (const [re, why] of FORBIDDEN) if (re.test(text)) problems.push(`${name}: ${f.path} ${why}`)
  }
}
if (problems.length) {
  console.error(`\n✗ ${problems.length} problem${problems.length > 1 ? 's' : ''}:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
  process.exit(1)
}
console.log('\n✓ tarballs contain only the CLI sources, README and LICENSE')
