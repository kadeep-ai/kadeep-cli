<p align="center"><a href="https://kadeep.ai"><img src="https://raw.githubusercontent.com/kadeep-ai/kadeep-cli/main/.github/assets/kadeep-studios-logo.svg" alt="KaDeep Studios logo" width="80" height="80"></a></p>

# releasegate: KaDeep Release Gate for CI/CD

**Engineering release confidence.** A go / no-go quality gate for your CI/CD pipeline, powered by KaDeep Studios.

[![npm](https://img.shields.io/npm/v/releasegate?color=0A0A0A)](https://www.npmjs.com/package/releasegate)
[![CI](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/kadeep-ai/kadeep-cli/actions/workflows/ci.yml)
![Node.js 20+](https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white)
![GitHub Actions · GitLab CI · CircleCI](https://img.shields.io/badge/CI-GitHub%20Actions%20%C2%B7%20GitLab%20%C2%B7%20CircleCI-2088FF)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Know exactly when to ship. `releasegate` asks [KaDeep Studios](https://kadeep.ai) about the exact commit under test and returns a **go or no-go, not a test report**. On every pull request or release build, it:

1. reads a **policy** file in your repository (`releasegate.yml`);
2. runs the KaDeep checks the policy requires against the current commit: test suites, individual test cases, and the localization quality gate;
3. writes a **report** as JSON, Markdown and JUnit, plus a GitHub job summary and annotations;
4. **passes or fails** the build.

Start in **shadow mode**, where it reports what it would have decided and never blocks. Switch to enforce mode when you trust it.

```
$ npx releasegate
KaDeep Release Gate 0.1.0 · Engineering release confidence.
project p_9a118f0499704752be72 · commit 8c3f2d1 on feature/checkout PR #214 · mode enforce · https://api.kadeep.ai
▸ Smoke
✓ Smoke: 12/12 passed (2m 41s)
▸ Checkout
✗ Checkout: 3/4 passed (1m 05s)
    ✗ Pay by card [DEFECT] · Expected "Order placed" to be visible
▸ Localization ready
✓ Localization ready: hi-IN, ar-AE ready (0s)

NO-GO · 2/3 required checks passed · 3m 47s
report: .releasegate/report.md
```

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [The policy file](#the-policy-file)
- [Modes: shadow and enforce](#modes-shadow-and-enforce)
- [Verdicts and exit codes](#verdicts-and-exit-codes)
- [CI setup](#ci-setup)
- [Reports](#reports)
- [Terminal output](#terminal-output)
- [Command reference](#command-reference)
- [How it works](#how-it-works)
- [Use it as a library](#use-it-as-a-library)
- [Troubleshooting](#troubleshooting)

## Install

Requires **Node.js 20 or newer** and a KaDeep project. Usually nothing needs installing: CI runs it with `npx`.

```sh
npx -y releasegate@^0.1            # in CI
npm install -D releasegate         # or pin it in your project
```

`releasegate` depends on [`kadeep`](https://www.npmjs.com/package/kadeep), the KaDeep CLI, and on `yaml`. It talks to the KaDeep API over HTTPS.

## Quick start

**The fast way**, from your repository:

```sh
npx kadeep login
npx kadeep init
```

`kadeep init` does three things:
- writes `releasegate.yml` in shadow mode and `.github/workflows/releasegate.yml`;
- creates the project's CI token;
- offers to store the token as the repository secret `KADEEP_CI_TOKEN`.

Commit both files and the gate runs on your next pull request.

**By hand:**

1. Create the project's CI token (`npx kadeep ci-token create`, or in KaDeep Studios under Settings → Connect) and store it as the CI secret `KADEEP_CI_TOKEN`.
2. Add `releasegate.yml`:

   ```yaml
   version: 1
   project: p_9a118f0499704752be72
   mode: shadow
   checks:
     - suite: smoke
   ```

3. Run `npx -y releasegate@^0.1` in CI with `KADEEP_CI_TOKEN` set (see [CI setup](#ci-setup)).

Check the policy locally without running anything: `npx releasegate --dry-run`.

## The policy file

`releasegate` looks for `releasegate.yml`, `releasegate.yaml`, `releasegate.json`, `.releasegate.yml` or `.github/releasegate.yml`, in that order. `--policy <file>` picks another.

```yaml
version: 1
project: p_9a118f0499704752be72      # KaDeep project id
mode: shadow                         # shadow | enforce (default enforce)

checks:
  - name: Smoke                      # a suite: every test in it must pass
    suite: smoke
    browser: chromium
    viewport: desktop
    timeoutMinutes: 30

  - name: Checkout                   # specific test cases
    tests: [login-works, checkout-works]

  - name: Mobile checkout            # advisory: reported, never blocks
    tests: [checkout-works]
    viewport: mobile
    required: false

  - name: Localization ready         # the localization quality gate
    localization:
      locales: [hi-IN, ar-AE]
      minCoverage: 100
      minMqm: 8
      requireApproved: true

report:
  dir: .releasegate
  junit: true
  markdown: true
```

### Top-level keys

| Key | Required | Default | Meaning |
| --- | --- | --- | --- |
| `version` | no | `1` | Policy format version; must be `1` |
| `project` | yes* | | KaDeep project id. *Or set `KADEEP_PROJECT` or pass `--project` |
| `mode` | no | `enforce` | `shadow` reports only; `enforce` fails the build on NO-GO |
| `checks` | yes | | At least one check |
| `report` | no | see below | Where and what to write |

### Checks

Each check has exactly **one** of `suite`, `tests` or `localization`.

| Key | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `suite` | suite | | Suite key, id or name; every test in it must pass |
| `tests` | tests | | A list of test keys, ids or names (a single string works too) |
| `localization` | localization | | The localization quality gate; `true` uses the defaults |
| `name` | all | derived | Label in the output and report |
| `required` | all | `true` | `false` makes the check advisory: reported, never blocks |
| `browser` | suite, tests | project setting | `chromium`, `chrome`, `msedge`, `firefox`, `webkit` |
| `viewport` | suite, tests | project setting | `desktop`, `laptop`, `tablet`, `mobile` |
| `timeoutMinutes` | suite, tests | `30` | How long to wait for the runs (1 to 240) |

### Localization rules

| Key | Default | Meaning |
| --- | --- | --- |
| `locales` | the project's target locales | Locales that must be ready |
| `minCoverage` | `100` | Minimum translated coverage, in percent |
| `minMqm` | none | Minimum MQM quality score |
| `requireApproved` | `true` | Every delivery for the locale must be approved |

A locale also fails if it has open **critical** flags.

### Report

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `.releasegate` | Output directory (add it to `.gitignore`) |
| `junit` | `true` | Write `junit.xml` |
| `markdown` | `true` | Write `report.md` |

Unknown keys are errors, with a "did you mean" suggestion. A typo can't silently drop a check, and every problem is reported at once:

```
releasegate.yml has 2 problems:
  - checks[0]: unknown key "suit" (did you mean "suite"?)
  - checks[0] needs exactly one of suite, tests or localization
```

## Modes: shadow and enforce

| Mode | Runs checks | Writes the report | Can fail the build |
| --- | --- | --- | --- |
| `shadow` | yes | yes | **never**, even if the policy or token is wrong |
| `enforce` | yes | yes | yes, on NO-GO or a setup error |

A safe rollout:

1. **Start in shadow mode.** `kadeep init` does this. The gate runs on every change, reports "would have blocked" when it disagrees, and blocks no one.
2. **Watch it.** Fix flaky tests and tune the policy until its verdicts match your judgement.
3. **Switch to enforce.** Set `mode: enforce` in `releasegate.yml`.

For a single run, `--shadow`, `--enforce`, `--mode <mode>` or `RELEASEGATE_MODE` override the policy's mode.

## Verdicts and exit codes

| Verdict | When |
| --- | --- |
| **GO** | Every required check passed |
| **NO-GO** | A required check failed or errored. An empty suite or a crashed run counts as an error, never a pass |
| **ERROR** | The gate could not evaluate: invalid policy, missing or rejected CI token, KaDeep unreachable. Remaining checks are skipped |

| Exit code | `enforce` | `shadow` |
| --- | --- | --- |
| `0` | GO | always |
| `1` | NO-GO | |
| `2` | ERROR: bad policy, token or setup | |
| `3` | ERROR: KaDeep unreachable | |

Advisory checks (`required: false`) appear in the report and annotations but never change the verdict.

## CI setup

In every case: Node.js 20+, the secret `KADEEP_CI_TOKEN`, and `npx -y releasegate@^0.1`.

**GitHub Actions**:

```yaml
name: KaDeep Release Gate
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  releasegate:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx -y releasegate@^0.1
        env:
          KADEEP_CI_TOKEN: ${{ secrets.KADEEP_CI_TOKEN }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: releasegate-report
          path: .releasegate/
```

On GitHub the gate also adds the Markdown report to the job summary and annotates failing checks.

**GitLab CI**:

```yaml
releasegate:
  image: node:22
  script: npx -y releasegate@^0.1
  artifacts:
    when: always
    paths: [.releasegate/]
    reports:
      junit: .releasegate/junit.xml
```

**CircleCI**:

```yaml
jobs:
  releasegate:
    docker: [{ image: cimg/node:22.0 }]
    steps:
      - checkout
      - run: npx -y releasegate@^0.1
      - store_test_results: { path: .releasegate }
      - store_artifacts: { path: .releasegate }
```

**Bitbucket Pipelines**:

```yaml
pipelines:
  pull-requests:
    '**':
      - step:
          image: node:22
          script:
            - npx -y releasegate@^0.1
          artifacts: [.releasegate/**]
```

The gate reads the commit, branch, PR number and run link from GitHub Actions, GitLab CI, CircleCI, Bitbucket Pipelines, Buildkite, Azure Pipelines and Jenkins. On a GitHub pull request it uses the PR head commit, not the merge commit. Anywhere else it asks `git`.

## Reports

Every run writes to `.releasegate/`, whatever the verdict, including setup errors:

| File | For |
| --- | --- |
| `report.json` | Machines: the full result (below) |
| `report.md` | People: a table of checks and the failing tests, readable in a PR |
| `junit.xml` | CI test dashboards: one test suite per check |

`report.json`:

```json
{
  "tool": "KaDeep Release Gate",
  "version": "0.1.0",
  "kadeep": "0.1.0",
  "verdict": "NO-GO",
  "mode": "enforce",
  "blocking": true,
  "project": "p_9a118f0499704752be72",
  "api": "https://api.kadeep.ai",
  "commit": { "provider": "github", "ci": true, "commit": "8c3f2d1e…", "branch": "feature/checkout", "pr": "214", "repo": "acme/web", "runUrl": "https://github.com/acme/web/actions/runs/4242" },
  "startedAt": "2026-09-29T09:12:03.120Z",
  "finishedAt": "2026-09-29T09:15:50.774Z",
  "durationMs": 227654,
  "checks": [
    {
      "name": "Checkout", "type": "tests", "required": true, "status": "failed", "summary": "3/4 passed",
      "passed": 3, "failed": 1, "total": 4, "jobs": ["job_…"],
      "runs": [{ "id": "r_…", "name": "Pay by card", "status": "failed", "verdict": "DEFECT", "error": "Expected \"Order placed\" to be visible", "report": "reports/…md" }]
    }
  ]
}
```

A check's `status` is one of `passed`, `failed`, `error` or `skipped` (not run after a fatal error).

## Terminal output

On a laptop, the gate draws a live checklist. Each check shows its tests as dots, and the verdict ends in large dots: green GO or red NO-GO.

<img src="https://raw.githubusercontent.com/kadeep-ai/kadeep-cli/main/.github/assets/screens/releasegate.png" alt="releasegate on a laptop: a checklist with a dot per test, the failing test, and NO-GO in large red dots" width="620">

In CI the output is plain lines with no escape sequences, plus the GitHub annotations and job summary described above, so CI logs stay clean. `NO_COLOR`, `--no-color` and `KADEEP_UI=plain` work as in [`kadeep`](https://www.npmjs.com/package/kadeep#terminal-output).

## Command reference

```
releasegate [options]
```

| Option | Meaning |
| --- | --- |
| `--policy <file>` | Policy file (default: the first of the names listed [above](#the-policy-file)) |
| `--mode enforce\|shadow` | Override the policy's mode |
| `--shadow` / `--enforce` | Short forms of `--mode` |
| `--report-dir <dir>` | Where the reports go (overrides `report.dir`) |
| `--dry-run` | Validate the policy and settings and list the checks; call nothing |
| `--json` | Print the report as JSON on stdout |
| `-p, --project <id>` | Override the policy's project |
| `--api <url>` | KaDeep API address (default `https://api.kadeep.ai`) |
| `--no-color` | Plain output |
| `-h, --help` / `-v, --version` | Help / version |

| Environment variable | Meaning |
| --- | --- |
| `KADEEP_CI_TOKEN` | The project's CI token. Required in CI; on a laptop a `kadeep login` session works for suite and test checks |
| `RELEASEGATE_MODE` | `enforce` or `shadow`, overriding the policy |
| `KADEEP_PROJECT` | Project id when the policy has none |
| `KADEEP_API` | API address |

`TESTSTUDIOS_CI_TOKEN` is read too, for pipelines set up for the older `teststudios` CLI.

## How it works

`releasegate` is a thin layer over [`kadeep`](https://www.npmjs.com/package/kadeep). It adds the policy, the verdict and the reports; `kadeep` does the rest:
- the API client and authentication;
- running tests;
- the localization gate;
- reading the commit from the CI environment;
- JUnit output.

For each check:
1. **Suite and test checks** start runs on KaDeep's queue with the CI token (`POST /api/ci/:project/run`, async), then poll the job until it finishes.
2. No request stays open while tests run, so proxies and load balancers with idle timeouts cannot cut a long suite, and a CI network blip only costs a retried poll.
3. **Localization checks** call KaDeep's localization quality gate for the listed locales.
4. The verdict is computed from the required checks, the reports are written, and the process exits with the code for the mode.

An invalid or rejected token stops the gate at the first check (`ERROR`) instead of failing every check separately.

## Use it as a library

```js
import { loadPolicy, runGate, exitCode, markdown } from 'releasegate'
import { createClient, ciContext, resolveApi } from 'kadeep'

const policy = loadPolicy('releasegate.yml')
const api = resolveApi()
const client = createClient({ api, auth: { kind: 'ci', token: process.env.KADEEP_CI_TOKEN } })
const report = await runGate({ policy, mode: policy.mode, project: policy.project, api, client, commit: ciContext() })
console.log(markdown(report))
process.exitCode = exitCode(report)
```

Also exported: `parsePolicy`, `findPolicy`, `PolicyError`, `junit`, `annotations`, `writeReports`, `errorReport`, `main`.

## Troubleshooting

| Message | What to do |
| --- | --- |
| `No release gate policy found` | Add `releasegate.yml` (`npx kadeep init`) or pass `--policy` |
| `KADEEP_CI_TOKEN is not set` | Add the secret and pass it to the step's environment |
| `The CI token was rejected` | The token was replaced (`kadeep ci-token create --yes`) or belongs to another project |
| `No tests ran: the suite has no test cases` | Add tests to the suite in KaDeep, or fix the suite key |
| `Test not found: …` | A test key in `tests:` does not exist; check `npx kadeep tests` |
| `Could not reach https://api.kadeep.ai` | Network or proxy from your CI runner (exit 3; shadow mode still exits 0) |

Found a bug? [Open an issue](https://github.com/kadeep-ai/kadeep-cli/issues).

## License

Apache-2.0 © Kadeep Technologies · [kadeep.ai](https://kadeep.ai)
