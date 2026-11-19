# Changelog

## 0.4.0

The agent-first release: kadeep now works on any URL, on your machine, with no account.

- `kadeep test <url> ["goal"]`: an AI QA engineer tests any URL (localhost, previews, VPN-only staging) in a local
  Playwright browser and returns a verdict with bugs, checks, console errors, failed requests and a screenshot per
  step. Runs on your `ANTHROPIC_API_KEY` or on KaDeep's plan. Exit 0 pass, 1 fail, 4 no verdict.
- `kadeep a11y <url>`: a deterministic WCAG 2.2 AA audit with axe-core. No model, no account.
- `kadeep try`: a free anonymous KaDeep trial for people and coding agents, with a claim link to keep the work.
- `kadeep init --agent`: adds the kadeep Agent Skill, an `AGENTS.md` section and MCP config to a repo. No sign-in.
- MCP: new `test_url`, `a11y_audit` and `start_trial` tools; tool errors include their error code.
- Distribution: Agent Skill (`npx skills add kadeep-ai/kadeep-cli`), Claude Code plugin and marketplace, MCP Registry
  entry (`io.github.kadeep-ai/kadeep`).
- Not-signed-in errors now say how to get started (`kadeep try`, sign-up link).
- Docs: CI examples pinned `releasegate@^0.1`, which never picked up later releases; they now use `^0.4`.
