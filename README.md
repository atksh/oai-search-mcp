# oai-search-mcp (GPT-6.1 Terra)

MCP server that gives AI agents web research powered by OpenAI's `gpt-6.1-terra` model and Programmatic Tool Calling (PTC).

Each MCP query runs a bounded PTC workflow. GPT-6.1 Terra writes JavaScript that may invoke a strict, read-only `search_web` function. The server fulfills each function call with a separate Responses API request using the stable `web_search` tool, returns citation and source metadata to the program, and continues until GPT-6.1 Terra produces a final answer.

## Requirements

- Node.js 22 or newer
- An OpenAI API key with GPT-6.1 Terra and Programmatic Tool Calling access
- An MCP-compatible client

## Installation

### npx

```sh
claude mcp add oai \
  -s user \
  -e OPENAI_API_KEY=your-api-key \
  -e SEARCH_CONTEXT_SIZE=medium \
  -e REASONING_EFFORT=high \
  -e OUTPUT_VERBOSITY=medium \
  -e OPENAI_API_TIMEOUT=300000 \
  -e OPENAI_MAX_RETRIES=3 \
  -- npx oai-search-mcp
```

### Manual MCP configuration

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "npx",
      "args": ["oai-search-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-api-key",
        "SEARCH_CONTEXT_SIZE": "medium",
        "REASONING_EFFORT": "high",
        "OUTPUT_VERBOSITY": "medium",
        "OPENAI_API_TIMEOUT": "300000",
        "OPENAI_MAX_RETRIES": "3"
      }
    }
  }
}
```

### Local development

```sh
git clone https://github.com/atksh/oai-search-mcp.git
cd oai-search-mcp
pnpm install
pnpm build
```

Use `node /path/to/oai-search-mcp/build/index.js` as the MCP command.

### Reading the key from `~/.zshrc`

To keep the key only in `~/.zshrc`, run the launcher instead of the server and leave `OPENAI_API_KEY` out of the client config:

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "npx",
      "args": ["-p", "oai-search-mcp", "oai-search-mcp-zshrc"]
      // From a clone: "command": "node", "args": ["/path/to/oai-search-mcp/bin/oai-search-mcp.mjs"]
    }
  }
}
```

On every start, the launcher runs a new interactive zsh, reads `OPENAI_API_KEY` from it, and then starts the server in the same process. `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` and `OPENAI_BASE_URL` are read too, because a key only works with its own organization, project and endpoint. When `~/.zshrc` defines them, they replace the client's values.

A rotated key reaches running servers as well. When the API rejects the key (HTTP 401), the server re-reads `~/.zshrc`, at most once every 30 seconds and once for all requests that failed together. If the key changed, it switches to the new key and retries each rejected request once. A client that caches its config, such as the Codex desktop app, still needs a restart to pick up config changes.

The shell is isolated from the MCP channel, so nothing in `~/.zshrc` can break the server:

- It has no controlling terminal (it starts in a new session), its stdin is `/dev/null`, and its stdout is discarded. Output, `read`s or terminal tricks in `~/.zshrc` are harmless.
- The values come back NUL-terminated on fd 11. Echoes, or `~/.zshrc` closing fds 3 to 9, cannot corrupt them, and a multi-line key is rejected instead of being truncated.
- It inherits the client's environment except the four OpenAI variables above and `ZDOTDIR`, with `SHELL` set to the zsh it runs. Stale values or a foreign `ZDOTDIR` from the client are ignored, while variables `~/.zshrc` may test, such as `TMUX` or `SSH_AUTH_SOCK`, still reach it.
- A `~/.zshrc` that hangs is killed after `OAI_SEARCH_ZSHRC_TIMEOUT_MS` (default `10000`, range 100 to 25000, which stays under client startup timeouts such as Codex's 30 s), or when the launcher gets SIGTERM, SIGINT or SIGHUP during the probe. A probe shell that keeps running after reporting the key, for example in a slow `EXIT` trap, is killed after 1 s.
- Background jobs started by `~/.zshrc` are not waited for or killed, and their stderr stays drained while the server runs.

If the key cannot be read at start, the launcher falls back to an inherited `OPENAI_API_KEY` and logs an error, whatever `LOG_LEVEL` says, because that key may be stale. With no valid inherited key it exits with status 1. The launcher keeps no copy of the key on disk, so there is no last-known-good key beyond that fallback. A `~/.zshrc` that needs a terminal to reach the key export, for example `read answer </dev/tty || return`, cannot work here, and neither can one that defines a function named `builtin`.

The launcher writes JSON lines to stderr in the server's log format (events `launcher_key_loaded`, `launcher_key_fallback`, `launcher_key_refreshed`, `launcher_warning`, `launcher_error`). Each start, and each re-read after a 401, also appends one JSON line to `~/Library/Logs/oai-search-mcp/launcher.log` on macOS (elsewhere `$XDG_STATE_HOME/oai-search-mcp/launcher.log`, or `~/.local/state/oai-search-mcp/launcher.log` when `XDG_STATE_HOME` is unset). The line records the time, the pid, the parent client, the key source (`zshrc`, `inherited` or `none`), the first 8 hex digits of the key's SHA-256, the OpenAI settings taken from `~/.zshrc`, and any failure reason, including an interruption by a signal, the end of zsh's stderr, or a server that failed to load. The key itself is never logged, and `sk-` tokens and long secret-like strings in zsh's stderr are redacted. Set `OAI_SEARCH_LAUNCHER_LOG` to another absolute path (a leading `~/` is expanded; anything that is not a regular file is refused), or to `off` to disable the log. To see which key a server uses, compare its `sha256` with `printf %s "$OPENAI_API_KEY" | shasum -a 256`.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes, unless the launcher reads it from `~/.zshrc` | — | OpenAI API key; never commit it |
| `SEARCH_CONTEXT_SIZE` | No | `medium` | Inner web-search context: `low`, `medium`, or `high` |
| `REASONING_EFFORT` | No | `high` | Outer PTC orchestration/synthesis effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `OUTPUT_VERBOSITY` | No | `medium` | Final answer verbosity: `low`, `medium`, or `high` |
| `OPENAI_API_TIMEOUT` | No | `300000` | Per-request timeout in milliseconds |
| `OPENAI_MAX_RETRIES` | No | `3` | SDK retry count for retryable API failures |
| `SYSTEM_PROMPT` | No | Built in | Replacement instructions for research and final-answer behavior |
| `SESSION_TTL_MS` | No | `14400000` | Session inactivity TTL (4 hours) |
| `MAX_SESSIONS` | No | `100` | Maximum in-memory sessions |
| `AUTO_COMPACTION` | No | `true` | Enable stored-conversation compaction |
| `COMPACTION_QUERY_THRESHOLD` | No | `20` | Queries before compaction |
| `COMPACTION_TOKEN_THRESHOLD` | No | `200000` | Outer conversation tokens before compaction |
| `LOG_LEVEL` | No | `info` | `debug`, `info`, `warn`, or `error` |
| `OAI_SEARCH_ZSHRC_TIMEOUT_MS` | No | `10000` | Launcher only: time allowed for `~/.zshrc` to run (100 to 25000) |
| `OAI_SEARCH_LAUNCHER_LOG` | No | see above | Launcher only: path of `launcher.log`, or `off` |

An unknown value of `SEARCH_CONTEXT_SIZE`, `REASONING_EFFORT`, `OUTPUT_VERBOSITY` or `LOG_LEVEL` is ignored with a warning on stderr, and the default is used.

`REASONING_EFFORT` applies only to the outer orchestration and final synthesis. Inner retrieval calls always use `none` so high-effort settings are not multiplied across every search.

## MCP tools

### `web-search`

```json
{
  "input": "Compare the current Node.js LTS releases and cite official sources.",
  "reasoningEffort": "medium",
  "searchContextSize": "high",
  "outputVerbosity": "medium"
}
```

The response remains compatible with v1:

```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT",
  "result": "Research answer with clickable source links",
  "warning": null
}
```

Pass `sessionId` on a later call to continue the stored OpenAI Responses conversation. Sessions expire after four hours by default.

### `web-search-batch`

```json
{
  "inputs": [
    "React hooks best practices",
    "Vue composition API updates",
    "Angular signals guidance"
  ],
  "reasoningEffort": "low",
  "outputFormat": "json"
}
```

The batch tool still accepts 1–10 independent inputs and supports `structured`, `plain`, and `json` output. It runs at most three PTC workflows concurrently and preserves input order.

## PTC limits and cost behavior

- Every MCP query uses `gpt-6.1-terra` for its outer PTC orchestration and final answer.
- A program may make at most five inner `search_web` calls.
- A workflow may continue for at most eight outer Responses rounds.
- Each inner function call makes another `gpt-6.1-terra` Responses request with `reasoning.effort: "none"` and the stable `web_search` tool.
- A full ten-item batch can therefore make at most fifty inner web-search requests.
- Malformed calls, unknown functions, incomplete responses, and budget overruns return structured errors to the program, including `remaining_calls`. The outer model then synthesizes from gathered evidence. The five-call and eight-round caps still apply; the server does not start an unbounded fallback loop.
- Logs separately report outer/inner tokens, cache reads/writes, PTC rounds, search-call counts, returned models, latency, and response item types.

PTC can reduce intermediate context by filtering and deduplicating results in hosted JavaScript, but this nested design can cost more and take longer than one direct web-search request. Evaluate it against your real workload.

## Citations

Inner web-search responses request the complete `web_search_call.action.sources` list and retain URL-citation metadata. The outer response is instructed to use clickable Markdown links. If a cited URL is absent from the generated answer, the server appends a deduplicated Sources section.

## Development and verification

```sh
pnpm test
pnpm build
make check
npm pack --dry-run
```

The deterministic test suite does not require an API key. Run the opt-in live GPT-6.1/PTC test separately:

```sh
OPENAI_API_KEY=... pnpm test:live
```

The live command verifies the returned model, `program`/`function_call`/`program_output`/`message` items, at least one inner search, final clickable source links, stored-response continuation, and continuation after standalone compaction output is replayed.

## Migration from v1.x

Version 2.0 is a breaking release because it requires Node.js 22+ and changes the internal cost/latency profile.

1. Upgrade the runtime to Node.js 22 or newer.
2. Ensure the API project can use the pinned model (`gpt-5.6-sol` in 2.0.0, `gpt-6.1-terra` since) and Programmatic Tool Calling.
3. Keep `OPENAI_MODEL` removed; the server remains intentionally pinned to one model.
4. Review rate and spend limits before using large batches.
5. Existing MCP tool inputs, response envelopes, session IDs, and batch formats remain unchanged; `max` is newly accepted for `reasoningEffort`.

## MCP resources and prompts

- Resource: `web-search://system-prompt`
- Prompts: `debug-error`, `compare-libraries`, `research-api`, `explore-documentation`

## Security

Keep `OPENAI_API_KEY` in `~/.zshrc` with the launcher, in the MCP client's environment, or in a secret manager. Do not place real credentials in scripts, configuration examples, logs, issues, or commits. Revoke and rotate any credential that has been stored in plaintext.

## License

MIT

## References

- [OpenAI GPT-6.1 Terra model page](https://developers.openai.com/api/docs/models/gpt-6.1-terra)
- [OpenAI latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
