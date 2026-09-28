# releasegate: KaDeep Release Gate

**Engineering release confidence.**

A go / no-go gate for CI:
1. Reads a policy file in your repository.
2. Runs the KaDeep checks it requires against the current commit: suites, test cases and the localization quality gate.
3. Writes a report.
4. Passes or fails the build.

```sh
npx releasegate
```

```
KaDeep Release Gate 0.1.0 · Engineering release confidence.
project prj_8f2c · commit 3b1e9a4 on feature/checkout PR #214 · mode enforce · https://api.kadeep.ai
▸ Smoke
✓ Smoke: 12/12 passed (2m 41s)
▸ Localization ready
✗ Localization ready: hi-IN: 2 deliveries not approved (translating) (0s)

NO-GO · 1/2 required checks passed · 2m 42s
report: .releasegate/report.md
```

Needs Node.js 20 or newer and a KaDeep project. The gate talks to the KaDeep API over HTTPS and is built on the [`kadeep`](https://www.npmjs.com/package/kadeep) CLI.

## Quick start

The fastest way is from your repository:

```sh
npx kadeep login
npx kadeep init          # writes releasegate.yml (shadow mode) and a GitHub Actions workflow
```

Then:
1. Store the project's CI token as the repository secret `KADEEP_CI_TOKEN`. `kadeep init` prints it, or create one with `npx kadeep ci-token create`.
2. Commit the files.

By hand: add `releasegate.yml` (below) and a CI step.

```yaml
# .github/workflows/kadeep-release-gate.yml
name: KaDeep Release Gate
on:
  pull_request:
  push:
    branches: [main]
jobs:
  release-gate:
    runs-on: ubuntu-latest
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

## Policy: `releasegate.yml`

```yaml
version: 1
project: prj_8f2c            # KaDeep project id
mode: shadow                 # shadow: report only · enforce: NO-GO fails the build
checks:
  - name: Smoke
    suite: smoke             # a suite: every test in it must pass
    browser: chromium        # optional: chromium, chrome, msedge, firefox, webkit
    viewport: desktop        # optional: desktop, laptop, tablet, mobile
    timeoutMinutes: 30       # optional, 1–240 (default 30)
  - name: Checkout
    tests: [login-works, checkout-works]
    required: false          # advisory: reported, never blocks
  - name: Localization ready
    localization:
      locales: [hi-IN, ar-AE]   # default: the project's target locales
      minCoverage: 100          # default 100
      minMqm: 8
      requireApproved: true     # default true
report:
  dir: .releasegate          # report.json, report.md, junit.xml
```

Each check has exactly one of `suite`, `tests` or `localization`. Checks are required unless `required: false`.

The gate looks for `releasegate.yml`, `.yaml` or `.json` in the working directory; `--policy <file>` picks another. Unknown keys are errors (with a "did you mean"), so a typo cannot silently drop a check.

## Verdicts, modes and exit codes

| Verdict | When |
| --- | --- |
| **GO** | Every required check passed |
| **NO-GO** | A required check failed or errored. An empty suite is an error, never a pass |
| **ERROR** | The gate could not evaluate: invalid policy, missing or wrong CI token, KaDeep unreachable |

| Mode | Exit code |
| --- | --- |
| `enforce` | `0` GO · `1` NO-GO · `2` bad policy, token or setup · `3` KaDeep unreachable |
| `shadow` | Always `0`. The report and the logs say what the verdict would have been |

**Rolling out**
1. Start in `shadow` mode (`kadeep init` does this). The gate runs on every change and reports without blocking anyone, even if the policy or token is wrong.
2. Once it has been green for a while, set `mode: enforce`.

`--mode`, `--shadow`, `--enforce` or `RELEASEGATE_MODE` override the policy for one run.

## Report

Every run writes the report to `.releasegate/`, whatever the verdict:
- `report.json`: verdict, mode, commit, and each check with its runs and failures.
- `report.md`: the same, readable in a PR.
- `junit.xml`: one suite per check, for CI test dashboards.

On GitHub Actions, the gate also:
- adds the Markdown report to the run summary;
- annotates failing checks: errors when they block, warnings in shadow mode or for advisory checks.

`--json` prints the report to stdout.

The commit is read from the CI environment: GitHub Actions (the PR head, not the merge commit), GitLab CI, CircleCI, Bitbucket Pipelines, Buildkite, Azure Pipelines and Jenkins. Anywhere else it falls back to `git`.

## Other CI providers

Run `npx -y releasegate@^0.1` with `KADEEP_CI_TOKEN` set from your secret store. For example, GitLab CI:

```yaml
release-gate:
  image: node:22
  script: npx -y releasegate@^0.1
  artifacts:
    when: always
    paths: [.releasegate/]
    reports:
      junit: .releasegate/junit.xml
```

## Options and environment

```
releasegate [--policy <file>] [--mode enforce|shadow | --shadow | --enforce] [--report-dir <dir>]
            [--dry-run] [--json] [--project <id>] [--api <url>]
```

- `--dry-run` validates the policy and settings and lists the checks, without calling KaDeep.

| Variable | Use |
| --- | --- |
| `KADEEP_CI_TOKEN` | The project's CI token (required in CI). On a laptop, a `kadeep login` session works for suite and test checks |
| `RELEASEGATE_MODE` | `enforce` or `shadow`, overriding the policy |
| `KADEEP_PROJECT` | Project id when the policy has none |
| `KADEEP_API` | API base URL (default `https://api.kadeep.ai`) |

## License

Apache-2.0 © Kadeep Technologies · [kadeep.ai](https://kadeep.ai)
