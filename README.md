# KaDeep CLI and Release Gate

**Engineering release confidence.**

[![CI](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Two npm packages for [KaDeep](https://kadeep.ai), the QA platform, published from this repository:

| Package | For | What it does |
| --- | --- | --- |
| [**`kadeep`**](packages/kadeep#readme) | Developers, scripts, coding agents | The KaDeep command line. Browse projects, suites and test cases; run tests and read results; localization; `kadeep init` to set up a repo and its CI; `kadeep mcp` so Cursor and Claude Code can use KaDeep as tools. `--json` on every command. |
| [**`releasegate`**](packages/releasegate#readme) | CI pipelines | KaDeep Release Gate. Reads `releasegate.yml`, runs the required KaDeep checks for the current commit, writes a report and passes or fails the build, with a non-blocking shadow mode for first-time setup. |

```sh
npx kadeep login          # sign in
npx kadeep init           # policy, CI workflow and agent config for this repo
npx releasegate           # in CI, with KADEEP_CI_TOKEN set: GO or NO-GO
```

## How the two packages fit together

```
                      ┌──────────────────────────────┐
  you, scripts,  ───▶ │ kadeep  (CLI + library)      │ ──HTTPS──▶  KaDeep API
  coding agents       │  commands · MCP server       │            (api.kadeep.ai)
                      │  client · runs · CI context  │
                      └──────────────▲───────────────┘
                                     │ imports (npm dependency)
                      ┌──────────────┴───────────────┐
  CI pipeline    ───▶ │ releasegate                  │
                      │  policy · verdict · reports  │
                      └──────────────────────────────┘
```

- **`kadeep` is the foundation.** It is a CLI and also a library: the API client, sign-in, runs, localization and CI detection. It has no runtime dependencies.
- **`releasegate` is built on `kadeep`.** It adds only what a gate needs: the policy file, the GO / NO-GO decision, shadow mode and the reports. It depends on `kadeep`, never the other way round.
- **`kadeep init` writes the gate's setup** (`releasegate.yml` and the CI workflow). CI then runs `npx releasegate`. A test in this repo checks that the policy `init` writes always passes `releasegate`'s parser.

They are separate packages because they serve different moments:
- **`kadeep`** is what a developer or agent uses all day.
- **`releasegate`** is one command a pipeline runs, with its own name, policy format and exit-code contract.

Both live in this repository and are released together at the same version.

## Development

```sh
npm install
npm run ci            # typecheck (JSDoc + checkJs), unit and fake-API tests, tarball check
```

- The sources are plain ES modules with JSDoc types. There is no build step, so what is in `packages/*/src` is what ships.
- Tests run on Node 20, 22 and 24 in CI.
- `scripts/check-packs.mjs` reads the exact file list `npm pack` would publish. It fails if anything other than `bin/`, `src/`, `README.md` and `LICENSE` would ship, or if a file contains a secret or a source map. It runs in CI and before every `npm publish`.

**Releasing:**
1. Bump both packages to the same version.
2. Update `releasegate`'s `kadeep` range if the minor version changed.
3. Publish `kadeep` first, then `releasegate`.

## License

Apache-2.0 © Kadeep Technologies
