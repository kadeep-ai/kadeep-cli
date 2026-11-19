# Contributing to kadeep

Thanks for helping. kadeep is two small npm packages with no build step: plain ES modules with JSDoc types.

```sh
git clone https://github.com/kadeep-ai/kadeep-cli.git && cd kadeep-cli
npm install
npm run ci          # typecheck (JSDoc + checkJs), tests on your Node, tarball check
```

- `packages/kadeep/src/local/`: the local runner (`kadeep test`, `kadeep a11y`). `runner.mjs` is the agent loop and is
  tested with a scripted model and a fake browser (`test/local.test.mjs`); `browser.mjs` is the Playwright side.
- `packages/kadeep/src/commands/`: one file per command group. `src/mcp.mjs`: the MCP server.
- `skills/kadeep/SKILL.md` is generated from `packages/kadeep/src/agent-skill.mjs`; edit the `.mjs` and run
  `node -e "import('./packages/kadeep/src/agent-skill.mjs').then(m=>require('fs').writeFileSync('skills/kadeep/SKILL.md',m.SKILL_MD))"`.
  A test fails if they differ.

## Ground rules

- The `kadeep` package keeps **zero runtime dependencies**. Anything heavy (Playwright, the Anthropic SDK, axe-core)
  is loaded through `src/local/runtime.mjs`, which installs it on first use.
- `--json` prints exactly one JSON document on stdout; progress goes to stderr. Error `code`s and exit codes are a
  contract that agents rely on: add, never rename.
- Every new command needs `--help` usage lines with a real example, and a test.
- Keep the tone of output and docs plain and specific.

## Good first issues

Look for [`good first issue`](https://github.com/kadeep-ai/kadeep-cli/labels/good%20first%20issue). If you want to
work on something bigger, open an issue first so we can agree on the shape.

## Reporting a bug kadeep got wrong

If `kadeep test` gave a wrong verdict, attach the `report.json` from `.kadeep/runs/…` (remove anything private) and
say what the right verdict was. These reports are how the QA agent gets better.
