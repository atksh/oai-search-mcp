# oai-search-mcp (GPT-5.6 Sol)

MCP server that gives AI agents web research powered by OpenAI's `gpt-5.6-sol` model and Programmatic Tool Calling (PTC).

Each MCP query runs a bounded PTC workflow. GPT-5.6 Sol writes JavaScript that may invoke a strict, read-only `search_web` function. The server fulfills each function call with a separate Responses API request using the stable `web_search` tool, returns citation and source metadata to the program, and continues until GPT-5.6 produces a final answer.

## Requirements

- Node.js 22 or newer
- An OpenAI API key with GPT-5.6 Sol and Programmatic Tool Calling access
- An MCP-compatible client

## Installation

### npx

```sh
claude mcp add oai \
  -s user \
  -e OPENAI_API_KEY=your-api-key \
  -e SEARCH_CONTEXT_SIZE=medium \
  -e REASONING_EFFORT=medium \
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
        "REASONING_EFFORT": "medium",
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

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Yes | — | OpenAI API key; never commit it |
| `SEARCH_CONTEXT_SIZE` | No | `medium` | Inner web-search context: `low`, `medium`, or `high` |
| `REASONING_EFFORT` | No | `medium` | Outer PTC orchestration/synthesis effort: `none`, `low`, `medium`, `high`, `xhigh`, or `max` |
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

- Every MCP query uses `gpt-5.6-sol` for its outer PTC orchestration and final answer.
- A program may make at most five inner `search_web` calls.
- A workflow may continue for at most eight outer Responses rounds.
- Each inner function call makes another `gpt-5.6-sol` Responses request with `reasoning.effort: "none"` and the stable `web_search` tool.
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

The deterministic test suite does not require an API key. Run the opt-in live GPT-5.6/PTC test separately:

```sh
OPENAI_API_KEY=... pnpm test:live
```

The live command verifies the returned model, `program`/`function_call`/`program_output`/`message` items, at least one inner search, final clickable source links, stored-response continuation, and continuation after standalone compaction output is replayed.

## Migration from v1.x

Version 2.0 is a breaking release because it requires Node.js 22+ and changes the internal cost/latency profile.

1. Upgrade the runtime to Node.js 22 or newer.
2. Ensure the API project can use `gpt-5.6-sol` and Programmatic Tool Calling.
3. Keep `OPENAI_MODEL` removed; the server remains intentionally pinned to one model.
4. Review rate and spend limits before using large batches.
5. Existing MCP tool inputs, response envelopes, session IDs, and batch formats remain unchanged; `max` is newly accepted for `reasoningEffort`.

## MCP resources and prompts

- Resource: `web-search://system-prompt`
- Prompts: `debug-error`, `compare-libraries`, `research-api`, `explore-documentation`

## Security

Keep `OPENAI_API_KEY` in the MCP client's environment or a secret manager. Do not place real credentials in scripts, configuration examples, logs, issues, or commits. Revoke and rotate any credential that has been stored in plaintext.

## License

MIT

## References

- [OpenAI GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Programmatic Tool Calling guide](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- [OpenAI web search guide](https://developers.openai.com/api/docs/guides/tools-web-search)
