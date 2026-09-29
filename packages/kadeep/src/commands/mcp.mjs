// @ts-check
import { serveMcp } from '../mcp.mjs'

/** @typedef {import('../cli.mjs').Command} Command */

/** @type {Command} */
const mcp = {
  name: 'mcp',
  summary: 'KaDeep as MCP tools for Cursor, Claude Code and other agents',
  usage: [
    'kadeep mcp',
    'Claude Code:  claude mcp add kadeep -- npx -y kadeep mcp',
    'Cursor:       .cursor/mcp.json → { "mcpServers": { "kadeep": { "command": "npx", "args": ["-y", "kadeep", "mcp"] } } }',
    'Sign in first with `kadeep login` (or set KADEEP_TOKEN); `kadeep init` writes both configs for a repo.'
  ],
  async run({ env }) {
    await serveMcp({ env })
  }
}

export default [mcp]
