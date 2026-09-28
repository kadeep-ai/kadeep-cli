// @ts-check
import { routes } from '../api.mjs'
import { EXIT, KadeepError } from '../errors.mjs'

/**
 * A project has at most one CI token, and creating one replaces it: every pipeline that holds the old token stops
 * working. So this refuses to replace an existing token unless `replace` is set.
 * @param {import('../client.mjs').Client} client
 * @param {{ id: string, name?: string, ciToken?: unknown }} project a project row from GET /api/projects
 * @param {{ replace?: boolean }} [opts]
 * @returns {Promise<{ token: string, replaced: boolean }>}
 */
export async function createCiToken(client, project, opts = {}) {
  const exists = Boolean(project.ciToken)
  if (exists && !opts.replace) throw new KadeepError(`${project.name ?? project.id} already has a CI token. A new one replaces it, and pipelines using the old one stop working. Re-run with --yes to replace it.`, { code: 'ci_token_exists', exitCode: EXIT.USAGE })
  const res = await routes.createCiToken(client, project.id)
  return { token: res.token, replaced: exists }
}
