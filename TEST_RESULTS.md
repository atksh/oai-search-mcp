# GPT-5.6 Sol and Programmatic Tool Calling - Test Results

**Date**: 2026-08-12
**Version**: 2.0.0
**Status**: Passed

## Verified behavior

- The runtime and nested search requests returned `gpt-5.6-sol` exclusively.
- Programmatic Tool Calling produced `program`, `function_call`, `program_output`, and final `message` items.
- The strict `search_web` function preserved program caller metadata and returned structured answers, URL citations, and consulted sources.
- Search, opened-page, and in-page action URLs are retained in the structured consulted-source list.
- Incomplete and failed inner Responses are returned to the PTC program as structured errors, including available failure details.
- Search execution is bounded to five inner calls and eight outer PTC rounds.
- Batch execution is bounded to three concurrent workflows while preserving input order.
- Stored-response continuation returned a linked answer.
- Standalone compaction output was replayed as input and the next turn completed successfully.
- The published MCP tool inputs, session response envelope, and batch output shapes remain compatible with v1.x; `max` is newly accepted for outer reasoning effort.

## Commands and results

| Command | Result |
| --- | --- |
| `pnpm test` | Passed: 11 tests, 0 failures |
| `pnpm build` | Passed: TypeScript compiled and runtime assets copied |
| `make check` | Passed: build artifacts verified |
| `pnpm test:live` | Passed: live GPT-5.6 Sol/PTC, citations, state, and compaction |
| `pnpm audit --prod` | Passed: no known vulnerabilities |
| Local MCP protocol smoke | Passed: tools and system-prompt resource discovered |
| `npm pack --dry-run` | Passed: publishable package assembled |
| Missing-key startup smoke | Passed: exited 1 with an actionable error |
| `git diff --check` | Passed |
| Tracked-patch credential scan | Passed: no API-key-shaped value found |

## Live smoke evidence

- Model: `gpt-5.6-sol`
- PTC rounds: 5
- Inner searches: 4
- Outer tokens: 6,391
- Inner tokens: 32,999
- Required response item types missing: none
- Unexpected returned models: none
- Initial and follow-up answers contained clickable links
- Post-compaction continuation completed

The live smoke intentionally uses the configured API key and incurs Responses API and web-search usage. It is excluded from the default deterministic test command.
