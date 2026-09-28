# KaDeep CLI and Release Gate

**Engineering release confidence.**

This repository holds two npm packages built on the [KaDeep](https://kadeep.ai) API:

| Package | What it is |
| --- | --- |
| [`kadeep`](packages/kadeep) | The KaDeep command line: browse projects, suites and test cases, run tests, read results, localization, `kadeep init` for a repo and CI, and `kadeep mcp` for Cursor and Claude Code. `--json` on every command. |
| [`releasegate`](packages/releasegate) | KaDeep Release Gate: a go / no-go gate for CI. It reads `releasegate.yml` in your repo, runs the required KaDeep checks for the current commit, writes a report and passes or fails the build. It has a non-blocking shadow mode for first-time setup. |

```sh
npx kadeep login
npx kadeep init        # policy, CI workflow and MCP config for this repo
npx releasegate        # in CI, with KADEEP_CI_TOKEN set
```

Both packages talk to the KaDeep API over HTTPS only, and `kadeep` has no runtime dependencies. `releasegate` builds on `kadeep`'s client instead of duplicating it.

## Development

```sh
npm install
npm run ci            # typecheck (JSDoc + checkJs), unit tests, tarball check
```

The sources are plain ES modules with JSDoc types. There is no build step, so what is in `packages/*/src` is what ships.

- `scripts/check-packs.mjs` reads the exact file list `npm pack` would publish.
- It fails if anything other than `bin/`, `src/`, `README.md` and `LICENSE` would ship, or if a file contains a secret or a source map.
- It runs in CI and before every `npm publish`.

## License

Apache-2.0 © Kadeep Technologies
