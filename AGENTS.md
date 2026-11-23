# Notes for coding agents working on this repository

- Run `npm run ci` before you finish: typecheck, all tests, tarball check. It must stay green on Node 20, 22 and 24.
- No runtime dependencies in `packages/kadeep`. Heavy modules load through `src/local/runtime.mjs`.
- Exit codes and `--json` error `code`s are a public contract (see `src/errors.mjs`); only add new ones.
- `skills/kadeep/SKILL.md` must equal `SKILL_MD` in `packages/kadeep/src/agent-skill.mjs` (a test checks).
- To test the local runner by hand: `node packages/kadeep/bin/kadeep.mjs test <url> "<goal>" --json`.
