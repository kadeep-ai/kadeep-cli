// @ts-check
import { parseArgs } from 'node:util'
import { resolveProject } from './api.mjs'
import { createClient, resolveAuth } from './client.mjs'
import { loadConfig, resolveApi } from './config.mjs'
import { EXIT, KadeepError, usage, VERSION } from './errors.mjs'
import { createOutput } from './output.mjs'
import auth from './commands/auth.mjs'
import browse from './commands/browse.mjs'
import ciToken from './commands/ci-token.mjs'
import init from './commands/init.mjs'
import jobs from './commands/jobs.mjs'
import loc from './commands/loc.mjs'
import mcp from './commands/mcp.mjs'
import run from './commands/run.mjs'

/**
 * @typedef {{ type: 'string' | 'boolean', short?: string, multiple?: boolean }} OptionSpec
 * @typedef {{
 *   name: string,
 *   aliases?: string[],
 *   summary: string,
 *   usage: string[],
 *   options?: Record<string, OptionSpec>,
 *   run: (ctx: Context) => Promise<number | void>
 * }} Command
 * @typedef {{
 *   values: Record<string, any>,
 *   positionals: string[],
 *   out: import('./output.mjs').Output,
 *   env: NodeJS.ProcessEnv,
 *   config: import('./config.mjs').Config,
 *   api: string,
 *   client: (need: 'user' | 'run' | 'ci' | 'any') => import('./client.mjs').Client,
 *   project: (client: import('./client.mjs').Client) => Promise<{ id: string, name?: string, [k: string]: unknown }>,
 *   num: (name: string) => number | undefined
 * }} Context
 */

/** @type {Record<string, OptionSpec>} */
const GLOBAL = {
  json: { type: 'boolean' },
  api: { type: 'string' },
  project: { type: 'string', short: 'p' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
  'no-color': { type: 'boolean' }
}

/** @type {Command[]} */
export const COMMANDS = [...auth, ...browse, ...run, ...jobs, ...loc, ...ciToken, ...init, ...mcp]

/** @param {string} name */
const find = (name) => COMMANDS.find((c) => c.name === name || c.aliases?.includes(name))

function globalHelp() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length))
  return [
    `kadeep ${VERSION}: KaDeep from the terminal, CI and coding agents. Engineering release confidence.`,
    '',
    'usage: kadeep <command> [options]',
    '',
    'commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'global options:',
    '  --json            print exactly one JSON document on stdout (for scripts and agents)',
    '  -p, --project     project id or name (default: KADEEP_PROJECT, then `kadeep use`)',
    '  --api <url>       KaDeep API (default: KADEEP_API, then the one you logged in to, then https://api.kadeep.ai)',
    '  --no-color        plain output',
    '  -h, --help        help for a command: kadeep <command> --help',
    '  -v, --version',
    '',
    'environment: KADEEP_API, KADEEP_PROJECT, KADEEP_TOKEN (access token), KADEEP_CI_TOKEN (project CI token)',
    'exit codes: 0 ok · 1 tests or gate failed · 2 usage, auth or not found · 3 KaDeep unreachable · 4 not ready yet'
  ].join('\n')
}

/** @param {Command} cmd */
function commandHelp(cmd) {
  return [`${cmd.summary}`, '', 'usage:', ...cmd.usage.map((u) => `  ${u}`), '', 'Global options (--json, --project, --api) work here too.'].join('\n')
}

/**
 * Run the CLI. Returns the exit code instead of exiting, so stdout is flushed before the process ends.
 * @param {string[]} argv
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>}
 */
export async function main(argv, { env = process.env } = {}) {
  const pre = parseArgs({ args: argv, options: GLOBAL, strict: false, allowPositionals: true })
  const wantsJson = Boolean(pre.values.json)
  let out = createOutput({ json: wantsJson, color: pre.values['no-color'] ? false : undefined })
  const name = pre.positionals[0]
  try {
    if (pre.values.version && !name) {
      out.result({ version: VERSION }, () => out.line(VERSION))
      return EXIT.OK
    }
    if (!name || name === 'help') {
      const target = name === 'help' && pre.positionals[1] ? find(pre.positionals[1]) : undefined
      out.result({ version: VERSION, commands: COMMANDS.map((c) => ({ name: c.name, aliases: c.aliases ?? [], summary: c.summary, usage: c.usage })) }, () => out.line(target ? commandHelp(target) : globalHelp()))
      return EXIT.OK
    }
    const cmd = find(name)
    if (!cmd) throw usage(`Unknown command "${name}". Run \`kadeep --help\` for the list.`)
    const rest = [...argv]
    rest.splice(rest.indexOf(name), 1)
    /** @type {{ values: Record<string, any>, positionals: string[] }} */
    let parsed
    try {
      parsed = parseArgs({ args: rest, options: { ...GLOBAL, ...cmd.options }, strict: true, allowPositionals: true })
    } catch (err) {
      throw usage(`${/** @type {Error} */ (err).message.replace(/\. To specify a positional argument.*$/s, '')}\nRun \`kadeep ${cmd.name} --help\`.`)
    }
    const values = parsed.values
    out = createOutput({ json: Boolean(values.json), color: values['no-color'] ? false : undefined })
    if (values.help) {
      out.result({ name: cmd.name, summary: cmd.summary, usage: cmd.usage, options: Object.keys(cmd.options ?? {}) }, () => out.line(commandHelp(cmd)))
      return EXIT.OK
    }
    const config = loadConfig(env)
    const api = resolveApi({ flag: values.api, env, config })
    /** @type {Context} */
    const ctx = {
      values,
      positionals: parsed.positionals,
      out,
      env,
      config,
      api,
      client: (need) => createClient({ api, auth: resolveAuth(need, { api, env, config }), env }),
      project: (client) => resolveProject(client, { ref: values.project, env, config }),
      num: (key) => {
        const v = values[key]
        if (v === undefined) return undefined
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0) throw usage(`--${key} must be a number ≥ 0`)
        return n
      }
    }
    return (await cmd.run(ctx)) ?? EXIT.OK
  } catch (err) {
    if (err instanceof KadeepError) {
      out.error(err)
      return err.exitCode
    }
    const e = /** @type {Error} */ (err)
    out.error({ message: e?.message ?? String(err), code: 'internal' })
    if (env.KADEEP_DEBUG) process.stderr.write(`${e?.stack ?? ''}\n`)
    return EXIT.FAILED
  }
}
