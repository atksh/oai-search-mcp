# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Search-budget hard fail**: When a PTC program requested more `search_web` calls than remained, the server threw and the MCP tool returned only `Error: Programmatic search budget exceeded`. Excess calls now receive a structured error, already-gathered evidence is kept, and the outer model continues to a final answer. Later rounds use `tool_choice: none` once the budget is spent.

### Changed

- **`search_web` output**: Each function result now includes `remaining_calls` so the hosted program can stop when the budget is exhausted.
- **PTC instructions**: The outer prompt now interpolates the configured cap and remaining search count on every round.

## [2.0.0] - 2026-08-12

### Breaking Changes

- **Node.js 22+**: Raised the supported runtime floor for OpenAI SDK 7.4.
- **Programmatic search path**: Replaced direct hosted web-search execution with a bounded GPT-5.6 Programmatic Tool Calling workflow. Existing MCP input and output envelopes remain compatible, but request cost and latency can increase because each program-issued search is a nested Responses request.

### Changed

- **GPT-5.6 Sol**: Replaced the hard-coded `gpt-5.5` model with explicit `gpt-5.6-sol` for both outer orchestration and inner web retrieval.
- **Stable web search**: Replaced `web_search_preview` with `web_search` and retained complete consulted-source metadata.
- **Retrieval failures**: Return non-completed inner search responses as structured errors and retain URLs from search, opened-page, and in-page actions.
- **Reasoning behavior**: Preserved `medium` as the outer default, added `max`, fixed inner retrieval at `none`, and explicitly retained `current_turn` reasoning context.
- **Bounded orchestration**: Limited each query to five inner searches and eight PTC rounds; limited batch execution to three concurrent workflows.
- **Observability**: Split outer/inner token, cache, call, round, model, and item-type logging.
- **Compaction continuity**: Replay standalone compaction output items on the next turn instead of treating the compaction object ID as a response ID.
- **Documentation and tests**: Added deterministic PTC continuation tests, an opt-in live smoke test, and v2 migration guidance.
- **Dependency security**: Updated the MCP SDK and Nano ID to patched releases and adjusted resource registration for the current SDK contract.

### Security

- Documented that API credentials must remain in the environment or a secret manager and that plaintext credentials should be revoked and rotated.

## [1.2.0] - 2026-05-15

### Changed

- **GPT-5.5 Only**: Updated the hard-coded model from `gpt-5.2` to `gpt-5.5`
- **GPT-5.5 guidance**: Refreshed docs and prompt language around efficient reasoning, outcome-first execution, precise tool use, and grounded research workflows
- **Compaction thresholds raised**: `COMPACTION_TOKEN_THRESHOLD` default 50,000 → 200,000, `COMPACTION_QUERY_THRESHOLD` default 10 → 20
- **Session TTL extended**: Default session TTL increased from 2h to 4h for longer research sessions
- **System prompt**: Updated model references and response rules for GPT-5.5
- **Documentation**: Updated README, package metadata, and test notes for GPT-5.5

## [1.1.0] - 2025-12-11

### Changed

- **GPT-5.2 Only**: Updated the hard-coded model from `gpt-5.1` to `gpt-5.2`
- **Reasoning effort expanded**: Added `xhigh` option across configuration and tool schemas
- **System prompt**: Refreshed guidance for GPT‑5.2 (verbosity clamps, ambiguity handling, long‑context recall)
- **Documentation**: Updated README, package metadata, and test notes for GPT‑5.2

## [1.0.0] - 2025-11-17

### Breaking Changes

- **GPT-5.1 Only**: Removed support for multiple models. The server now exclusively uses GPT-5.1
- **Removed `OPENAI_MODEL` environment variable**: Model is now hard-coded to `gpt-5.1`
- **All documentation and code now in English**: Migrated from mixed language content to English-only

### Added

- **`none` reasoning effort option**: New low-latency mode for tasks that don't require reasoning
  - Use `REASONING_EFFORT=none` for fastest responses on simple queries
  - Added to both `web-search` and `web-search-batch` tools
- **Enhanced batch output formatting**:
  - Executive summary with statistics and query overview
  - Improved individual result presentation with clear sections and metadata
  - Success/failure indicators with visual markers
  - Completion summary footer
  - Better visual separation between results
- **Comprehensive system prompt rewrite**:
  - Optimized for GPT-5.1's characteristics (persistence, completeness)
  - Clear guidelines for adaptive verbosity based on query complexity
  - Enhanced source verification and citation instructions
  - Structured response templates
  - Quality checklist for consistent outputs

### Changed

- **Default model**: Hard-coded to `gpt-5.1` (previously configurable via `OPENAI_MODEL`)
- **System prompt**: Completely rewritten in English based on GPT-5.1 prompting guide best practices
  - Emphasizes persistence and completeness to counter over-conciseness
  - Provides clear output formatting guidelines for different query complexities
  - Includes structured response templates and quality checklists
- **README.md**: Fully rewritten in English
  - Focused on GPT-5.1 features and benefits
  - Added migration guide from earlier versions
  - Enhanced documentation of all features and configuration options
  - Removed references to deprecated models
- **Reasoning effort descriptions**: Updated to include `none` option with clear use case guidance

### Migration Guide

If you're upgrading from v0.0.x:

1. Remove `OPENAI_MODEL` environment variable from your configuration
2. Server now uses GPT-5.1 exclusively - ensure your OpenAI API key has access
3. Consider using `REASONING_EFFORT=none` for low-latency use cases
4. Review the new system prompt in `SYSTEM_PROMPT.md` if you use custom prompts
5. Batch output format is enhanced - update any parsing logic if using `outputFormat: "structured"`

### Technical Details

- Model: GPT-5.1 with improved calibration and steerability
- Reasoning effort: `none` | `low` | `medium` (default) | `high`
- All internal code and comments now in English
- Enhanced error handling and user feedback in batch operations

## [0.0.9] - 2025-08-24

### Changed

- Increased default OPENAI_API_TIMEOUT from 60000ms (1 minute) to 300000ms (5 minutes)

## [0.0.8] - 2025-08-24

### Added

- Support for configurable model selection via OPENAI_MODEL environment variable

## [0.0.7] - 2025-08-06

### Fixed

- Removed console.log breaking MCP JSON-RPC communication (#11)

### Changed

- Updated README files with new badge layout and structure
- Added support for 4 languages in README (English, Japanese, Chinese, Korean)

### Added

- MseeP.ai badge to README.md (#10)

### Thanks

- @yoichiojima-2 for fixing MCP JSON-RPC communication issue (#11)
- @lwsinclair for adding MseeP.ai badge (#10)

## [0.0.6] - 2025-01-20

### Changed

- Updated syntax highlighting in README from json to jsonc (#9)
- Improved README and package.json description for better clarity

### Removed

- Removed unused minimist dependency (#8)

### Thanks

- @debiru for updating syntax highlighting in README (#9)
- @acro5piano for removing unused minimist dependency (#8)

## [0.0.5] - 2025-01-16

### Changed

- Updated tool description for better clarity
- Formatted code with Prettier for consistency

## [0.0.4] - 2025-01-12

### Added

- Configurable retry and timeout for OpenAI API (#6)
- MCP server badge (#1)
- MIT LICENSE file
- Release command setup
- Local setup configuration

### Thanks

- @wildgeece96 for adding configurable retry and timeout for OpenAI API (#6)
- @punkpeye for adding MCP server badge (#1)

[Unreleased]: https://github.com/atksh/oai-search-mcp/compare/v2.0.0...HEAD
[2.0.0]: https://github.com/atksh/oai-search-mcp/compare/v1.2.0...v2.0.0
[1.2.0]: https://github.com/atksh/oai-search-mcp/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/atksh/oai-search-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/atksh/oai-search-mcp/compare/v0.0.9...v1.0.0
[0.0.9]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/yoshiko-pg/o3-search-mcp/compare/v0.0.3...v0.0.4
