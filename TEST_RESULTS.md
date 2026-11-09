# GPT-6.1 Terra, the `~/.zshrc` Key Launcher and Key Rotation - Test Results

**Date**: 2026-11-09
**Version**: Unreleased (after 2.0.0)
**Status**: Passed

## Verified behavior

- The runtime and nested search requests returned `gpt-6.1-terra` exclusively, in the live smoke test and in two MCP searches through the launcher.
- Programmatic Tool Calling on `gpt-6.1-terra` produced `program`, `function_call`, `program_output`, and final `message` items.
- Stored-response continuation returned a linked answer, and standalone compaction output was replayed as input and the next turn completed.
- With no `reasoningEffort` in the tool call and no `REASONING_EFFORT` set, the stored outer response recorded `reasoning.effort: "high"`.
- The launcher read `OPENAI_API_KEY` from the real `~/.zshrc` (logged by SHA-256 fingerprint only) under the normal environment and a Dock-like minimal environment, in 30 concurrent starts, and with a stale `OPENAI_API_KEY` or a foreign `ZDOTDIR` inherited.
- Fixture `~/.zshrc` files that echo, read stdin, close fds 3 to 9, alias `print`, hang, exit early, start background jobs, or set a multi-line key behave as documented. The probe shell never gets a controlling terminal, even under a pty.
- A SIGTERM during the probe killed the probe shell in 40 of 40 runs at 8-way parallelism, and the launcher logs the interruption before it dies.
- Unknown `REASONING_EFFORT`, `SEARCH_CONTEXT_SIZE`, `OUTPUT_VERBOSITY` and `LOG_LEVEL` values are ignored with a warning; differently cased valid values are accepted.
- After `~/.zshrc` changed under a running server, a 401 made it re-read the key once, switch to the new key and organization, and retry the request once; the next request used the new key directly. Without the launcher a 401 is returned once, with no retry (fake API, `bin/zshrc-key.test.mjs`).
- `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_BASE_URL` from `~/.zshrc` replace the client's values; the real `~/.zshrc` defines none of them.
- With `@modelcontextprotocol/sdk` 1.32.2 and `zod` 4.6.7, the published tool schemas keep their enums, required fields and descriptions, and a live two-query batch through the launcher succeeded on `gpt-6.1-terra`.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm test` | Passed: builds first, then 53 tests, 0 failures, 0 skipped |
| `ZDOTDIR=<empty dir> node --test bin/zshrc-key.test.mjs` | Passed: 41 tests |
| `node --test bin/zshrc-key.test.mjs`, 4 copies in parallel | With the final suite, 16 of 16 runs passed, 4 of them under 8 busy `yes` processes. Before that, 28 runs passed and one batch of 12 had failures whose test names were not captured |
| `pnpm build` | Passed: TypeScript compiled and runtime assets copied |
| `make check` | Passed: build artifacts verified |
| `pnpm test:live` | Passed: live GPT-6.1 Terra/PTC, citations, state, and compaction |
| MCP search through `bin/oai-search-mcp.mjs` | Passed: single searches at effort `medium` (explicit) and `high` (default), and a two-query batch after the dependency upgrade |
| `npm pack --dry-run` | Passed: package includes `bin/oai-search-mcp.mjs`, `bin/launcher-config.mjs` and `bin/zshrc-key.mjs`, not the test |
| `git diff --check` | Passed |
| Tracked-patch credential scan | Passed: no API-key-shaped value found |
| `pnpm audit --prod` | Passed: no known vulnerabilities (was 33 before the dependency upgrade) |

## Live smoke evidence

- Model: `gpt-6.1-terra`
- PTC rounds: 3
- Inner searches: 2
- Outer tokens: 4,937
- Inner tokens: 26,097
- Required response item types missing: none
- Unexpected returned models: none
- Initial and follow-up answers contained clickable links
- Post-compaction continuation completed

The live run preceded the change that makes the smoke test also require at least one inner search; it reported 2. The live smoke intentionally uses the configured API key and incurs Responses API and web-search usage. It is excluded from the default deterministic test command.
