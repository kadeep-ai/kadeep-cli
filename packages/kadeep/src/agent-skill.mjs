// @ts-check

/**
 * The kadeep Agent Skill (agentskills.io SKILL.md format): what a coding agent reads to know when and how to test with
 * kadeep. `kadeep init --agent` writes it into a repo; the same text is skills/kadeep/SKILL.md at the root of the
 * kadeep-cli repository (a test keeps the two identical), which `npx skills add kadeep-ai/kadeep-cli` and the Claude
 * Code plugin install.
 */
export const SKILL_MD = `---
name: kadeep
description: Test web apps like a QA engineer with the kadeep CLI. Use after changing UI, routes, forms, auth or checkout, before saying a frontend task is done, when asked to "test", "QA", "check it works", "find bugs" or "check accessibility", and when a user reports something broken in the browser. Runs a real browser locally (localhost included) and returns a pass/fail verdict with bugs, console errors, failed requests and screenshots.
---

# kadeep: verify web changes in a real browser

\`kadeep test\` sends an AI QA engineer through your app in a local Playwright browser and returns a verdict you can act
on. It reaches localhost, preview URLs and VPN-only staging. \`kadeep a11y\` is a deterministic WCAG 2.2 AA audit.

## When to use it

- After you change anything a user sees or clicks: run the journey you touched, read the verdict, fix, run again.
- Before you report a frontend task as done. "It compiles" is not "it works".
- When the user says something is broken in the browser: reproduce it with \`kadeep test\` first.
- For accessibility work, or before a release: \`kadeep a11y <url>\`.

## Commands

\`\`\`sh
npx -y kadeep test http://localhost:3000 "sign up with a new email and reach the dashboard" --json
npx -y kadeep test http://localhost:3000/cart "change the quantity to 3 and check the total updates" --viewport mobile --json
npx -y kadeep test http://localhost:3000 --json            # no goal: explore the page and hunt for bugs
npx -y kadeep a11y http://localhost:3000/checkout --json
\`\`\`

Start the dev server first and give the exact URL of the page where the journey begins. Write the goal as a user
journey with a visible outcome ("...and see the order number"), not as implementation details. One journey per run;
run several in a row for several journeys.

## Reading the result

\`--json\` prints one JSON document on stdout:

- \`verdict\`: \`pass\` | \`fail\` | \`error\` (no verdict: blocked, unreachable, out of steps). Exit code 0 / 1 / 4.
- \`summary\` and \`checks[]\`: what was verified.
- \`bugs[]\`: \`{ title, severity, steps, expected, actual, url, screenshot }\`. Fix critical and major ones.
- \`console[]\` (console errors, uncaught exceptions) and \`network[]\` (requests that failed or returned 4xx/5xx):
  often the fastest pointer to the root cause in your code.
- \`artifacts.dir\`: screenshots of every step and \`report.json\` (under \`.kadeep/runs/\`; keep \`.kadeep/\` out of git).

Exit code 2 means usage or no model; 3 means the URL or the model was unreachable (is the dev server running?).

## If it asks for a model or a sign-in

\`kadeep test\` uses \`ANTHROPIC_API_KEY\` when it is set. Otherwise run \`npx -y kadeep try\`: a free anonymous trial,
no sign-up, saved on this machine. It prints a claim link; give that link to the user so they can keep the results.
Never ask the user to paste secrets into the chat.

## Beyond local runs

Signed in to KaDeep Studios (\`npx kadeep login\`), the same CLI runs saved suites in the cloud on web, iOS, Android
and desktop (\`kadeep run --suite smoke\`), and \`npx releasegate\` turns them into a go / no-go gate in CI. As MCP
tools: \`claude mcp add kadeep -- npx -y kadeep mcp\` (tools \`test_url\`, \`a11y_audit\`, \`start_trial\`, plus the
project tools).
`

/** The section `kadeep init --agent` adds to AGENTS.md (read by Codex, Cursor, Gemini CLI and others). */
export const AGENTS_SECTION = `<!-- kadeep:start -->
## Testing UI changes

After changing anything a user sees or clicks, verify it in a real browser before calling the task done:

\`\`\`sh
npx -y kadeep test <url-of-the-page> "<the user journey you changed, with its visible outcome>" --json
\`\`\`

Read \`verdict\`, \`bugs\`, \`console\` and \`network\` in the output; fix what it reports and run it again. For
accessibility, \`npx -y kadeep a11y <url> --json\`. If it asks for a model, run \`npx -y kadeep try\` (free, no
sign-up). Details: .claude/skills/kadeep/SKILL.md
<!-- kadeep:end -->
`
