# kadeep

**Engineering release confidence.**

The KaDeep command line. Everything you do with your tests in the KaDeep app, from a terminal, a CI job or a coding agent:

- browse projects, suites and test cases
- run tests and read the results
- push and pull localization and check its quality gate
- give Cursor or Claude Code KaDeep as a set of tools (MCP)

```sh
npx kadeep login
npx kadeep run --suite smoke
```

Needs Node.js 20 or newer. `kadeep` talks to the KaDeep API over HTTPS (default `https://api.kadeep.ai`) and has no runtime dependencies.

## Install

```sh
npx kadeep --help        # run it without installing
npm install -g kadeep    # or install the `kadeep` command globally
```

## Sign in

```sh
kadeep login                   # asks for your KaDeep email and password
kadeep whoami
kadeep use "Acme web"          # default project, so --project becomes optional
```

In a script, pipe the password in: `printf '%s' "$KADEEP_PASSWORD" | kadeep login --email you@acme.com --password-stdin`.

- The session is saved to `~/.config/kadeep/config.json`, readable only by you. It uses `$XDG_CONFIG_HOME/kadeep` or `%APPDATA%\kadeep` when those are set.
- The session renews itself while you use it. It ends when you run `kadeep logout`, revoke it in the app, or leave it unused for 30 days.
- Sessions are stored per API, so a token is only ever sent to the server that issued it.

## Browse

| Command | What it shows |
| --- | --- |
| `kadeep projects` | Your projects (`*` marks the default) |
| `kadeep suites` | Suites in the project, with test counts and last result |
| `kadeep tests [--suite smoke] [--label checkout] [--search login]` | Test cases |
| `kadeep tests show <test>` | One test case: instructions, steps, expected result |
| `kadeep runs [--test <test>] [--limit 50]` | Recent runs |
| `kadeep runs show <runId>` | One run, step by step, with the verdict and report link |
| `kadeep suite-runs [--suite smoke]` / `kadeep suite-runs show <id>` | Suite runs and their results |
| `kadeep issues [--status new]` | Defects KaDeep filed |

Every command takes `--project <id or name>`. Without it, kadeep uses `KADEEP_PROJECT`, then your `kadeep use` default, then your only project.

## Run tests

```sh
kadeep run --suite smoke
kadeep run --test login-works --test checkout-works
kadeep run --suite smoke --browser firefox --viewport mobile --junit results.xml
kadeep run --suite smoke --no-wait            # queue it and return the job id
kadeep jobs show <jobId> --wait               # follow it later
```

- A run is a job on KaDeep's queue: `kadeep` starts it and polls until it finishes. Closing the terminal or losing the network does not stop the run.
- The exit code is `1` when any test fails.
- A suite with no test cases counts as an error, never a pass.
- Engines: `chromium`, `chrome`, `msedge`, `firefox`, `webkit`.
- Viewports: `desktop`, `laptop`, `tablet`, `mobile`.
- `--timeout` sets how many minutes to wait (default 30).

## For scripts and coding agents: `--json`

With `--json`, stdout carries exactly one JSON document: the result, or `{ "ok": false, "error": "…", "code": "…" }`. Progress goes to stderr, so stdout can always be parsed.

```sh
kadeep tests --suite smoke --json | jq -r '.[].key'
kadeep run --suite smoke --json | jq '{status, passed, failed}'
```

| Exit code | Meaning |
| --- | --- |
| `0` | OK |
| `1` | Tests failed, or a localization gate failed |
| `2` | Usage, sign-in or not-found problem (`code`: `usage`, `auth_required`, `auth_invalid`, `ci_token_required`, `ci_token_exists`, `not_found`, `forbidden`, `bad_request`) |
| `3` | KaDeep unreachable or a server error (`network`, `timeout`, `server`, `rate_limited`) |
| `4` | Localization delivery not approved yet (`not_ready`) |

`kadeep --help --json` lists every command with its usage.

## CI

CI jobs use the project's **CI token** instead of a personal login:

```sh
kadeep ci-token create          # shown once; store it as the CI secret KADEEP_CI_TOKEN
```

A project has one CI token. Creating a new one replaces the old one, so kadeep asks before replacing (or needs `--yes`).

```sh
KADEEP_CI_TOKEN=… npx kadeep run --project <projectId> --suite smoke --junit results.xml
```

For a go / no-go decision on every release, use [`releasegate`](https://www.npmjs.com/package/releasegate), the KaDeep Release Gate. It is built on this package.

## Set up a repository: `kadeep init`

```sh
cd your-repo
npx kadeep init
```

- Writes `releasegate.yml`, the gate's policy. It starts in **shadow** mode: it reports but never blocks.
- Writes `.github/workflows/kadeep-release-gate.yml`, which runs the gate on pull requests and on pushes to your main branch.
- Adds a `kadeep` MCP server to `.mcp.json` (Claude Code) and `.cursor/mcp.json` (Cursor).
- Adds `.releasegate/` to `.gitignore`.
- Never overwrites an existing file without `--force`. JSON configs are merged.
- Creates the project's CI token only if the project has none. It can store the token as a GitHub secret with `gh`, but only when you say yes.

Without prompts: `kadeep init --yes --project <id> --suite smoke [--ci github|none] [--no-mcp] [--no-ci-token]`.

## MCP: KaDeep in Cursor and Claude Code

`kadeep mcp` serves KaDeep as [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio. Sign in once with `kadeep login` (or set `KADEEP_TOKEN`), then add the server.

**Claude Code**

```sh
claude mcp add kadeep -- npx -y kadeep mcp
```

**Cursor**: in `.cursor/mcp.json` (or `~/.cursor/mcp.json`):

```json
{ "mcpServers": { "kadeep": { "command": "npx", "args": ["-y", "kadeep", "mcp"], "env": { "KADEEP_PROJECT": "<projectId>" } } } }
```

Tools:
- `projects_list`, `suites_list`, `tests_list`, `tests_get`
- `run`: waits for the verdict, or returns a job id
- `job_status`, `runs_list`, `run_get`, `suite_runs_list`, `suite_run_get`, `issues_list`, `whoami`
- `loc_status` and `loc_validate`: these need `KADEEP_CI_TOKEN`

Results are the same JSON as `--json`.

## Localization

The same commands as `teststudios loc`. They use the project's CI token (`KADEEP_CI_TOKEN`) and `--project <id>`.

```sh
kadeep loc push --file locales/en.json [--translate] [--ref main] [--commit <sha>]
kadeep loc pull --asset en.json --locale hi-IN --out locales/hi.json [--format xliff|tmx]
kadeep loc status
kadeep loc validate --locale hi-IN --locale ar-AE [--min-coverage 100] [--min-mqm 8] [--allow-unapproved]
```

`loc pull` exits `4` while the delivery is not approved.

## Environment

| Variable | Use |
| --- | --- |
| `KADEEP_API` | API base URL (default `https://api.kadeep.ai`) |
| `KADEEP_PROJECT` | Default project id or name |
| `KADEEP_TOKEN` | A KaDeep access token, instead of `kadeep login` |
| `KADEEP_CI_TOKEN` | The project's CI token (CI, `loc`, releasegate) |
| `KADEEP_CONFIG_DIR` | Where the session is stored |
| `NO_COLOR` | Plain output |

`TESTSTUDIOS_API` and `TESTSTUDIOS_CI_TOKEN` are read too, so CI set up for the older `teststudios` CLI keeps working.

## As a library

```js
import { createClient, resolveApi, resolveAuth, runTests } from 'kadeep'

const api = resolveApi()
const client = createClient({ api, auth: resolveAuth('run', { api }) })
const result = await runTests(client, { project: 'prj_…', suite: 'smoke' })
console.log(result.status, `${result.passed}/${result.total}`)
```

## License

Apache-2.0 © Kadeep Technologies · [kadeep.ai](https://kadeep.ai)
