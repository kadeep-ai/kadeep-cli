<p align="center"><a href="https://kadeep.ai"><img src="https://raw.githubusercontent.com/kadeep-ai/kadeep-cli/main/.github/assets/kadeep-studios-logo.svg" alt="KaDeep Studios logo" width="80" height="80"></a></p>

# kadeep: the KaDeep Studios CLI

**Engineering release confidence.** AI end-to-end testing from your terminal, your CI/CD pipeline and your coding agents.

[![npm](https://img.shields.io/npm/v/kadeep?color=0A0A0A)](https://www.npmjs.com/package/kadeep)
[![CI](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![MCP server](https://img.shields.io/badge/MCP-server-6E56CF)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

[KaDeep Studios](https://kadeep.ai) is an autonomous release-readiness QA agent. It runs the user journeys that make you revenue on web, mobile and desktop, and returns a go or no-go, not a test report. `kadeep` is its command line: anything you do with your tests in KaDeep Studios, you can script from a terminal, a CI job or an AI coding agent.

- **Browse** projects, suites, test cases, runs and defects.
- **Run** a suite or individual test cases and wait for the verdict, with JUnit output for CI.
- **Read results** step by step, including why a test failed.
- **Set up a repository** in one command: a `releasegate` policy, a GitHub Actions workflow and agent config.
- **Give coding agents KaDeep as tools.** `kadeep mcp` is an MCP server for Cursor, Claude Code and any other MCP client.
- **Localization:** push source strings, pull approved translations, and check the quality gate.

Every command takes `--json`, and exit codes and error codes are stable, so scripts and agents can rely on the output.

```sh
npx kadeep login
npx kadeep run --suite smoke
```

New to KaDeep Studios? [Get started for free](https://kadeep.ai/start).

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Signing in](#signing-in)
- [Choosing a project](#choosing-a-project)
- [Usage](#usage)
  - [Browse your tests](#browse-your-tests)
  - [Run tests](#run-tests)
  - [Read results](#read-results)
  - [Run in CI](#run-in-ci)
  - [Set up a repository](#set-up-a-repository)
  - [Coding agents (MCP)](#coding-agents-mcp)
  - [Localization](#localization)
- [Command reference](#command-reference)
- [Output for scripts and agents](#output-for-scripts-and-agents)
- [Configuration](#configuration)
- [Use it as a library](#use-it-as-a-library)
- [Troubleshooting](#troubleshooting)

## Install

Requires **Node.js 20 or newer**. `kadeep` has no runtime dependencies and talks to the KaDeep API over HTTPS (`https://api.kadeep.ai` by default).

```sh
npx kadeep --help          # run without installing
npm install -g kadeep      # or install the `kadeep` command globally
npm install -D kadeep      # or pin it in a project (then: npx kadeep …)
```

## Quick start

```sh
kadeep login                          # your KaDeep email and password
kadeep projects                       # what you can see
kadeep use "Acme web"                 # default project for the commands below
kadeep suites                         # suites and their test counts
kadeep run --suite smoke              # run it and wait for the verdict
kadeep runs show <runId>              # what happened, step by step
```

Example run:

```
$ kadeep run --suite smoke
KaDeep: running suite smoke in Acme web on https://api.kadeep.ai …
  running · 1/3 · Case 2 of 3
✓ Login works
✓ Search returns results
✗ Checkout works [DEFECT] — Expected "Order placed" to be visible
2/3 passed in 1m 12s  (suite run sr_1cb5eb20b855)
```

## Signing in

`kadeep` offers three ways to authenticate. Pick the one that fits where it runs.

| Where | How | Can do |
| --- | --- | --- |
| Your terminal | `kadeep login` (email and password) | Everything |
| Scripts, agents | `KADEEP_TOKEN=<access token>` | Everything; the token is not renewed |
| CI pipelines | `KADEEP_CI_TOKEN=<project CI token>` and `--project <id>` | `run`, `jobs`, `loc`; also used by [releasegate](https://www.npmjs.com/package/releasegate) |

```sh
kadeep login                                                          # prompts for email and password
printf '%s' "$KADEEP_PASSWORD" | kadeep login --email you@acme.com --password-stdin   # non-interactive
kadeep whoami
kadeep logout                                                         # also ends the session on KaDeep
```

- The session is saved to `~/.config/kadeep/config.json`, readable only by you. `$XDG_CONFIG_HOME`, `%APPDATA%` on Windows, or `KADEEP_CONFIG_DIR` change the location.
- It renews itself while you use it, and ends after 30 days unused, on `kadeep logout`, or when revoked in KaDeep Studios.
- Sessions are stored per API address, so a token is only ever sent to the server that issued it.

## Choosing a project

Commands act on one project. `kadeep` picks it in this order:

1. `--project <id or name>` (or `-p`)
2. `KADEEP_PROJECT`
3. your default for this API, set with `kadeep use <project>`
4. your only project, if you have just one

A CI token cannot list projects, so in CI pass the project **id**.

## Usage

### Browse your tests

```sh
kadeep projects                               # * marks your default
kadeep suites
kadeep tests                                  # every test case in the project
kadeep tests --suite smoke                    # only the ones in a suite
kadeep tests --label checkout --search pay    # filter by label and text
kadeep tests show login-works                 # instructions, steps, expected result, last run
```

Test cases are called **flows** in the KaDeep API, so `kadeep flows` works as an alias of `kadeep tests`. Tests and suites can be referred to by key, id or name.

### Run tests

```sh
kadeep run --suite smoke
kadeep run --test login-works --test checkout-works
kadeep run --suite smoke --browser firefox --viewport mobile
kadeep run --suite smoke --junit results.xml          # JUnit for CI dashboards
kadeep run --suite regression --timeout 60            # wait up to 60 minutes (default 30)
```

- A run is a **job** on KaDeep's queue. `kadeep` starts it and polls until it finishes, so closing the terminal or losing the network never stops the run.
- To queue a run and come back later:

```sh
kadeep run --suite regression --no-wait               # prints the job id and returns
kadeep jobs show job_8ad6a6bb92                        # current state
kadeep jobs show job_8ad6a6bb92 --wait                 # follow it to the verdict
```

`run` exits `1` if any test fails. A suite with no test cases, or a job that ends without results, is an **error**, never a pass.

### Read results

```sh
kadeep runs                                   # recent runs: status, verdict, duration
kadeep runs --test checkout-works --limit 50
kadeep runs show r_bf6382d90aab               # each step, the verdict and its reason, the report
kadeep suite-runs --suite smoke               # suite runs with pass / fail counts
kadeep suite-runs show sr_1cb5eb20b855        # every test in that suite run
kadeep issues --status new                    # defects KaDeep filed
```

```
$ kadeep runs show r_bf6382d90aab
✗ Checkout works  failed [DEFECT]  19s  r_bf6382d90aab
The confirmation never appeared after paying.
assert: FAIL text_visible: "Order placed" is not visible

    1. ok   navigate · Opened https://shop.acme.test/ (HTTP 200)
    2. ok   click Add to cart
    3. FAIL assert · FAIL text_visible: "Order placed" is not visible
```

### Run in CI

CI uses the project's **CI token** instead of a personal login. Create it once and store it as a secret named `KADEEP_CI_TOKEN`:

```sh
kadeep ci-token create          # shown once
gh secret set KADEEP_CI_TOKEN   # e.g. on GitHub
```

Then, in any pipeline:

```sh
npx -y kadeep run --project <projectId> --suite smoke --junit results.xml
```

For a go / no-go decision on every change (a policy file, several checks, reports and a shadow mode), use [`releasegate`](https://www.npmjs.com/package/releasegate), the KaDeep Release Gate. It is built on this package.

### Set up a repository

```sh
cd your-repo
npx kadeep init
```

`init` asks for the project and the suite to gate on, then writes these files:

| File | Purpose |
| --- | --- |
| `releasegate.yml` | Release gate policy, starting in **shadow** mode (reports, never blocks) |
| `.github/workflows/releasegate.yml` | Runs `releasegate` on pull requests and pushes to your main branch |
| `.mcp.json` / `.cursor/mcp.json` | The `kadeep` MCP server for Claude Code and Cursor, pinned to this project |
| `.gitignore` | Ignores `.releasegate/` (the gate's reports) |

It also:
- creates the project's CI token if the project has none, and can store it as a GitHub secret with `gh` if you say yes;
- never replaces an existing token;
- never overwrites a file without `--force`, and merges JSON configs rather than replacing them.

Non-interactive: `kadeep init --yes --project <id> --suite smoke`.

### Coding agents (MCP)

`kadeep mcp` serves KaDeep as [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio. Sign in once with `kadeep login` (or set `KADEEP_TOKEN`), then register it.

**Claude Code**

```sh
claude mcp add kadeep -- npx -y kadeep mcp
```

**Cursor**: `.cursor/mcp.json` in the repo, or `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "kadeep": { "command": "npx", "args": ["-y", "kadeep", "mcp"], "env": { "KADEEP_PROJECT": "<projectId>" } }
  }
}
```

The agent can then answer "which smoke tests are failing and why?" or "run the checkout tests" by itself. The tools are listed in the [MCP tools](#mcp-tools) reference.

### Localization

These use the project's CI token (`KADEEP_CI_TOKEN`) and the project id:

```sh
kadeep loc push --file locales/en.json --translate          # new source version (+ translate empty strings)
kadeep loc status                                            # coverage, readiness and deliveries per locale
kadeep loc validate --locale hi-IN --locale ar-AE --min-mqm 8   # the quality gate: exit 1 with reasons
kadeep loc pull --asset en.json --locale hi-IN --out locales/hi.json   # approved translations only
```

`loc pull` exits `4` while the delivery is not approved yet.

## Command reference

Global options, accepted by every command:

| Option | Meaning |
| --- | --- |
| `--json` | Print exactly one JSON document on stdout |
| `-p, --project <id or name>` | Project to act on (see [Choosing a project](#choosing-a-project)) |
| `--api <url>` | KaDeep API address (default `https://api.kadeep.ai`) |
| `--no-color` | Plain output |
| `-h, --help` | Help for a command: `kadeep <command> --help` |
| `-v, --version` | Print the version |

### Account

| Command | Options | What it does |
| --- | --- | --- |
| `kadeep login` | `--email <email>`, `--password-stdin` | Sign in; stores a session for this API. Also reads the email from `KADEEP_EMAIL` |
| `kadeep logout` | | End the session here and on KaDeep |
| `kadeep whoami` | | The account, role and API in use |

### Projects and tests

| Command | Options | What it does |
| --- | --- | --- |
| `kadeep projects` | | List your projects; `*` marks the default |
| `kadeep use <project>` | | Set the default project for this API |
| `kadeep suites` | | Suites with key, test count and last result |
| `kadeep tests [list]` | `--suite <key>`, `--label <label>`, `--search <text>` | Test cases. Aliases: `flows`, `test-cases` |
| `kadeep tests show <test>` | | One test case in full |

### Runs and results

| Command | Options | What it does |
| --- | --- | --- |
| `kadeep run` | `--suite <key>` or `--test <key>` (repeatable), `--browser <engine>`, `--viewport <size>`, `--junit <file>`, `--no-wait`, `--timeout <minutes>` | Run and wait for the verdict. Engines: `chromium`, `chrome`, `msedge`, `firefox`, `webkit`. Viewports: `desktop`, `laptop`, `tablet`, `mobile` |
| `kadeep jobs show <jobId>` | `--wait`, `--timeout <minutes>` | A queued or running job; `--wait` follows it to the verdict |
| `kadeep runs [list]` | `--test <key>`, `--limit <n>` (default 20) | Recent runs |
| `kadeep runs show <runId>` | | One run, step by step |
| `kadeep suite-runs [list]` | `--suite <key>`, `--limit <n>` (default 20) | Recent suite runs |
| `kadeep suite-runs show <id>` | | A suite run's results |
| `kadeep issues` | `--status new\|dismissed\|closed` | Defects. Alias: `defects` |

### Setup and CI

| Command | Options | What it does |
| --- | --- | --- |
| `kadeep init` | `--suite <key>`, `--ci github\|none`, `--no-mcp`, `--no-ci-token`, `--yes`, `--force`, `--dir <path>` | Set up a repository (see [Set up a repository](#set-up-a-repository)) |
| `kadeep ci-token create` | `--yes` | Create the project's CI token. `--yes` replaces an existing one, which breaks pipelines still using it |
| `kadeep mcp` | | Start the MCP server on stdio |

### Localization

| Command | Options | What it does |
| --- | --- | --- |
| `kadeep loc push` | `--file <path>`, `--translate`, `--ref <branch>`, `--commit <sha>` | Upload a source file as a new asset version. In CI, the branch and commit are filled in automatically |
| `kadeep loc pull` | `--asset <name or id>`, `--locale <tag>`, `--out <path>`, `--format xliff\|tmx` | Download the approved translation (exit 4 if not approved yet) |
| `kadeep loc status` | | Coverage, readiness and critical flags per locale, and delivery states |
| `kadeep loc validate` | `--locale <tag>` (repeatable), `--min-coverage <pct>`, `--min-mqm <n>`, `--allow-unapproved` | The localization quality gate (exit 1 with the reasons) |

### MCP tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `whoami` | | Account and API |
| `projects_list` | | Projects |
| `suites_list` | `project?` | Suites |
| `tests_list` | `project?`, `suite?`, `label?`, `search?` | Test cases |
| `tests_get` | `test`, `project?` | One test case |
| `run` | `suite` or `tests[]`, `project?`, `browser?`, `viewport?`, `wait?` (default true), `max_wait_seconds?` (default 600) | The verdict, or a job id to follow |
| `job_status` | `job_id`, `wait?`, `max_wait_seconds?` | A job's state or verdict |
| `runs_list` | `project?`, `test?`, `limit?` | Recent runs |
| `run_get` | `run_id` | One run, step by step |
| `suite_runs_list` | `project?`, `suite?`, `limit?` | Recent suite runs |
| `suite_run_get` | `suite_run_id`, `project?` | A suite run's results |
| `issues_list` | `project?`, `status?` | Defects |
| `loc_status` | `project?` | Localization status (needs `KADEEP_CI_TOKEN`) |
| `loc_validate` | `project?`, `locales?`, `min_coverage?`, `min_mqm?`, `allow_unapproved?` | Localization gate (needs `KADEEP_CI_TOKEN`) |

Tool results are the same JSON as the matching command's `--json` output. `run` reports progress notifications while it waits.

## Output for scripts and agents

With `--json`, stdout carries exactly **one** JSON document: either the result, or an error object like `{ "ok": false, "error": "…", "code": "…" }`. Progress and prompts go to stderr, so stdout can always be parsed.

```sh
kadeep tests --suite smoke --json | jq -r '.[].key'
kadeep run --suite smoke --json | jq '{status, passed, failed}'
kadeep --help --json                          # every command with its usage
```

`kadeep run --json` (and `jobs show --wait --json`) returns:

```json
{
  "ok": false,
  "status": "failed",
  "kind": "suite",
  "target": "Smoke",
  "project": "p_9a118f0499704752be72",
  "lane": "session",
  "suiteRunId": "sr_1cb5eb20b855",
  "passed": 2,
  "failed": 1,
  "total": 3,
  "runs": [
    { "id": "r_18c7598e38", "name": "Checkout works", "status": "failed", "verdict": "DEFECT", "durationMs": 18938, "error": "Expected \"Order placed\" to be visible", "summary": "…", "report": "reports/…md" }
  ],
  "jobs": ["job_8ad6a6bb92"],
  "durationMs": 72000
}
```

`status` is one of:

| `status` | Meaning |
| --- | --- |
| `passed` | Every test passed |
| `failed` | At least one test failed |
| `error` | Nothing ran, or a job crashed or was cancelled |
| `timeout` | Still running when `--timeout` ran out; follow it with `jobs show --wait` |
| `queued` | Started with `--no-wait` |

### Exit codes

| Code | Meaning | Error `code` values |
| --- | --- | --- |
| `0` | Success | |
| `1` | Tests failed, or a localization gate failed | `failed`, `conflict` |
| `2` | Usage, sign-in, permission or not-found problem | `usage`, `auth_required`, `auth_invalid`, `ci_token_required`, `ci_token_exists`, `not_found`, `forbidden`, `bad_request` |
| `3` | KaDeep unreachable or a server error | `network`, `timeout`, `server`, `rate_limited` |
| `4` | Localization delivery not approved yet | `not_ready` |

## Configuration

| Variable | Use |
| --- | --- |
| `KADEEP_API` | API address (default `https://api.kadeep.ai`) |
| `KADEEP_PROJECT` | Default project id or name |
| `KADEEP_TOKEN` | An access token, used instead of `kadeep login` |
| `KADEEP_CI_TOKEN` | The project's CI token |
| `KADEEP_EMAIL` | Email for `kadeep login` |
| `KADEEP_CONFIG_DIR` | Where the session and defaults are stored |
| `NO_COLOR` | Plain output |

`TESTSTUDIOS_API` and `TESTSTUDIOS_CI_TOKEN` are read too, so pipelines set up for the older `teststudios` CLI keep working.

The API address is resolved in this order: `--api`, then `KADEEP_API`, then the API you last logged in to, then `https://api.kadeep.ai`.

## Use it as a library

The package exports the client and operations the CLI is built on. [`releasegate`](https://www.npmjs.com/package/releasegate) uses them.

```js
import { createClient, resolveApi, resolveAuth, runTests, listTests } from 'kadeep'

const api = resolveApi()                                    // same rules as the CLI
const client = createClient({ api, auth: resolveAuth('run', { api }) })
const tests = await listTests(client, 'p_9a118f0499704752be72', { suite: 'smoke' })
const result = await runTests(client, { project: 'p_9a118f0499704752be72', suite: 'smoke' })
console.log(result.status, `${result.passed}/${result.total}`)
```

Also exported:
- **Data:** `getTest`, `listRuns`, `getRun`, `listSuiteRuns`, `getSuiteRun`, `listIssues`, `listProjects`, `listSuites`
- **Jobs and localization:** `jobStatus`, `locPush`, `locPull`, `locStatus`, `locValidate`
- **Helpers:** `ciContext` (commit, branch and PR from the CI environment), `junitXml`
- **Errors:** `KadeepError`, whose `code` and `exitCode` match the tables above

## Troubleshooting

| Message | What to do |
| --- | --- |
| `Not logged in to … Run kadeep login` | Sign in, or set `KADEEP_TOKEN` / `KADEEP_CI_TOKEN` |
| `Your KaDeep session expired or was signed out` | `kadeep login` again |
| `Which project? …` | Pass `--project`, set `KADEEP_PROJECT`, or run `kadeep use <project>` |
| `This needs the project's CI token` | Set `KADEEP_CI_TOKEN` (`kadeep ci-token create`) |
| `The CI token was rejected` | The token was replaced or belongs to another project; check `--project` |
| `Could not reach …` | Network, proxy or `--api` address |

Set `KADEEP_DEBUG=1` to print a stack trace for unexpected errors. Found a bug? [Open an issue](https://github.com/kadeep-ai/kadeep-cli/issues).

## License

Apache-2.0 © Kadeep Technologies · [kadeep.ai](https://kadeep.ai)
