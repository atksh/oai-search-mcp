# oai-search-mcp (GPT-5.5)

MCP server that enables AI agents to leverage OpenAI's GPT-5.5 model with powerful web search capabilities. By registering this server with any AI coding agent, the agent can autonomously consult GPT-5.5 to solve complex problems through intelligent web searches.

## Why GPT-5.5?

GPT-5.5 is a strong fit for production search and research workflows that need:

- **Efficient reasoning**: Strong results with fewer reasoning tokens in complex, tool-heavy, and multi-step workflows
- **Outcome-first execution**: Better adherence to clear goals, success criteria, evidence rules, and output shape
- **Precise tool use**: Stronger tool selection and argument discipline on large or long-running tool surfaces
- **Grounded long-context retrieval**: Designed for coding use cases, grounded assistants, and research workflows
- **Modern Responses features**: Supports prompt caching, hosted tools, tool search, compaction, and stored conversation state

## Use Cases

### 🐛 When You're Stuck Debugging

GPT-5.5's web search can scan GitHub issues, Stack Overflow, and documentation to find solutions for niche problems.

**Example prompts:**
```
> I'm getting the following error on startup, please fix it. If it's too difficult, ask oai.
> [Paste error message here]
```
```
> The WebSocket connection isn't working. Please debug it. If you don't know how, ask oai.
```

### 📚 When You Need Latest Library Information

Get answers from powerful web search even when documentation is scattered or incomplete.

**Example prompts:**
```
> I want to upgrade this library to v2. Proceed while consulting with oai.
```
```
> I was told this option doesn't exist. It might have been removed. Ask oai what to specify instead.
```

### 🧩 When Tackling Complex Tasks

Use GPT-5.5 not just for search, but as a design consultant and problem-solving partner.

**Example prompts:**
```
> I want to create a collaborative editor. Please design it and ask oai for a design review.
```

The AI agent may autonomously decide to consult GPT-5.5 when it deems necessary, dramatically expanding the range of problems it can solve independently!

## Installation

### npx (Recommended)

#### Claude Desktop / Claude Code

```sh
claude mcp add oai \
  -s user \  # Omit this line to install in project scope
  -e OPENAI_API_KEY=your-api-key \
  -e SEARCH_CONTEXT_SIZE=medium \
  -e REASONING_EFFORT=medium \
  -e OUTPUT_VERBOSITY=medium \
  -e OPENAI_API_TIMEOUT=300000 \
  -e OPENAI_MAX_RETRIES=3 \
  -- npx oai-search-mcp
```

#### Manual JSON Configuration

Add to your MCP settings file:

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "npx",
      "args": ["oai-search-mcp"],
	  "env": {
	    "OPENAI_API_KEY": "your-api-key",
	    // Optional: low, medium, high (default: medium)
	    "SEARCH_CONTEXT_SIZE": "medium",
	    // Optional: none, low, medium, high, xhigh (default: medium)
	    "REASONING_EFFORT": "medium",
	    // Optional: low, medium, high (default: medium)
	    "OUTPUT_VERBOSITY": "medium",
        // Optional: API timeout in milliseconds (default: 300000)
        "OPENAI_API_TIMEOUT": "300000",
        // Optional: Maximum number of retries (default: 3)
        "OPENAI_MAX_RETRIES": "3",
        // Optional: Custom system prompt (uses default if not specified)
        "SYSTEM_PROMPT": "Your custom instructions here"
      }
    }
  }
}
```

### Local Setup

If you want to download and run the code locally:

```bash
git clone https://github.com/atksh/oai-search-mcp.git
cd oai-search-mcp
pnpm install
pnpm build
```

#### Claude Desktop / Claude Code

```sh
claude mcp add oai \
  -s user \
  -e OPENAI_API_KEY=your-api-key \
  -e SEARCH_CONTEXT_SIZE=medium \
  -e REASONING_EFFORT=medium \
  -e OUTPUT_VERBOSITY=medium \
  -e OPENAI_API_TIMEOUT=300000 \
  -e OPENAI_MAX_RETRIES=3 \
  -- node /path/to/oai-search-mcp/build/index.js
```

#### Manual JSON Configuration

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "node",
      "args": ["/path/to/oai-search-mcp/build/index.js"],
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

## Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | **Yes** | - | Your OpenAI API key |
| `SEARCH_CONTEXT_SIZE` | No | `medium` | Search context size<br>**Values**: `low`, `medium`, `high`<br>Higher values retrieve more search results for better coverage |
| `REASONING_EFFORT` | No | `medium` | GPT-5.5 reasoning effort level<br>**Values**: `none`, `low`, `medium`, `high`, `xhigh`<br>`none`: No reasoning, fastest for latency-critical tasks<br>`low`: Efficient reasoning for lighter search and analysis<br>`medium`: Balanced (recommended)<br>`high`: Thorough, slower<br>`xhigh`: Maximum deliberation for hardest tasks |
| `OUTPUT_VERBOSITY` | No | `medium` | Response detail level<br>**Values**: `low`, `medium`, `high`<br>`low`: Concise answers<br>`medium`: Balanced detail<br>`high`: Comprehensive with full context |
| `OPENAI_API_TIMEOUT` | No | `300000` | API request timeout in milliseconds<br>Default: 300000 (5 minutes) |
| `OPENAI_MAX_RETRIES` | No | `3` | Maximum retries for failed requests<br>The SDK automatically retries on rate limits (429), server errors (5xx), and connection errors |
| `SYSTEM_PROMPT` | No | _(default)_ | Custom system prompt for response style<br>If not provided, uses the built-in prompt optimized for GPT-5.5 |
| `SESSION_TTL_MS` | No | `14400000` | Session time-to-live in milliseconds (default: 4 hours) |
| `MAX_SESSIONS` | No | `100` | Maximum number of concurrent sessions |
| `AUTO_COMPACTION` | No | `true` | Enable automatic conversation compaction |
| `COMPACTION_QUERY_THRESHOLD` | No | `20` | Number of queries before triggering compaction |
| `COMPACTION_TOKEN_THRESHOLD` | No | `200000` | Token count threshold for triggering compaction |
| `LOG_LEVEL` | No | `info` | Logging level<br>**Values**: `debug`, `info`, `warn`, `error` |

## Features

### 🔍 Single Web Search

Execute a single intelligent web search with GPT-5.5:

```typescript
// Tool: web-search
{
  "input": "How to optimize React rendering performance?",
  "reasoningEffort": "medium",
  "searchContextSize": "high",
  "outputVerbosity": "high"
}
```

**Response format (JSON):**
```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT",
  "result": "To optimize React rendering performance...",
  "warning": null
}
```

### 🔄 Session Support (Conversation Continuity)

Maintain conversation context across multiple queries using session IDs:

```typescript
// First query - session auto-created
{
  "input": "What is React 19?"
}
// Response: { "sessionId": "abc123...", "result": "React 19 is..." }

// Follow-up query - context preserved
{
  "input": "How do I upgrade from v18?",
  "sessionId": "abc123..."
}
// Response: { "sessionId": "abc123...", "result": "To upgrade from React 18..." }
```

**Session behavior:**
- **Auto-creation**: If `sessionId` is omitted, a new session is created automatically
- **Continuation**: Pass the returned `sessionId` to continue the conversation
- **TTL**: Sessions expire after 4 hours of inactivity (configurable via `SESSION_TTL_MS`)
- **Invalid ID**: Returns an error if the session ID is invalid or expired

### 🗜️ Automatic Compaction

Long conversations are automatically compacted to manage context size:

- **Query threshold**: Compacts after 20 queries (configurable via `COMPACTION_QUERY_THRESHOLD`)
- **Token threshold**: Compacts when total tokens exceed 200,000 (configurable via `COMPACTION_TOKEN_THRESHOLD`)
- **Graceful handling**: If compaction fails, the conversation continues with a warning

### 📦 Batch Web Search

Execute multiple searches in parallel for efficiency:

```typescript
// Tool: web-search-batch
{
  "inputs": [
    "React hooks best practices",
    "Vue 3 composition API",
    "Angular signals"
  ],
  "reasoningEffort": "low",
  "outputFormat": "structured"  // structured, plain, or json
}
```

**Output formats:**
- `structured` (default): Enhanced presentation with executive summary, query overview, individual results with metadata, and completion summary
- `plain`: All results combined in a single text block with markdown formatting
- `json`: Structured JSON with status, results, and errors for programmatic processing

### 📋 MCP Resources

Access the system prompt configuration:

```typescript
// Resource: system-prompt
// URI: web-search://system-prompt
```

### 🎯 MCP Prompts

Pre-configured prompt templates for common tasks:

- `debug-error`: Debug and troubleshoot error messages
- `compare-libraries`: Compare multiple libraries or technologies
- `research-api`: Research API or library documentation
- `explore-documentation`: Explore and understand technology documentation

## GPT-5.5 Optimizations

This MCP server is specifically optimized for GPT-5.5's strengths:

### Outcome-First Answers

The system prompt asks GPT‑5.5 to identify the requested outcome, answer directly, and stop once the answer, evidence, and caveats are complete.

### Explicit Verbosity Clamps

GPT‑5.5 is direct by default, so the prompt sets concrete length/shape targets and respects the runtime’s `OUTPUT_VERBOSITY` instruction.

### Reasoning Effort Knob

Use `REASONING_EFFORT=low` for efficient everyday searches that still benefit from reasoning. Reserve `none` for latency-critical tasks that need little or no multi-step analysis:
- Fast fact retrieval
- Simple status checks
- Lightweight classification
- Straightforward questions with narrow scope

Use `medium`, `high`, or `xhigh` for:
- Complex problem solving
- Multi-step analysis
- Design decisions
- Debugging difficult issues

### Ambiguity & Freshness Handling

The prompt instructs GPT‑5.5 to avoid hallucinating on underspecified queries, cover multiple plausible intents with assumptions, and rely on web research for time‑sensitive facts.

## Tips for Best Results

1. **Be specific in queries**: "How to fix React useState closure issue" works better than "React problem"
2. **Use batch search for comparisons**: Compare multiple options simultaneously for consistent analysis
3. **Adjust reasoning effort**: Use `none` for speed, `high` for difficult problems
4. **Leverage verbosity control**: Set `low` for quick answers, `high` for learning in-depth
5. **Customize the system prompt**: Tailor response style to your team's needs
6. **Use sessions for follow-ups**: Pass `sessionId` to ask follow-up questions without repeating context

## Migration from Earlier Versions

### From v1.1.x to v1.2.0

**Changes:**
1. Model upgraded from GPT-5.2 to GPT-5.5
2. Default `COMPACTION_TOKEN_THRESHOLD` increased from 50,000 to 200,000
3. Default `COMPACTION_QUERY_THRESHOLD` increased from 10 to 20
4. Default `SESSION_TTL_MS` increased from 7,200,000 (2h) to 14,400,000 (4h)
5. Built-in system prompt refreshed for outcome-first answers, citation discipline, and clear stopping conditions

**Migration steps:**
1. Ensure your OpenAI API key has GPT-5.5 access
2. Review your custom `COMPACTION_TOKEN_THRESHOLD` if set — the default is now 200,000
3. Note: sessions now last 4 hours by default; override with `SESSION_TTL_MS` if needed
4. Review custom `SYSTEM_PROMPT` values if you depend on older GPT-5.2 prompt behavior

### From v1.0.x to v1.1.0

**Breaking Change**: The `web-search` tool now returns JSON instead of plain text.

**Before (v1.0.x):**
```
To optimize React rendering performance...
```

**After (v1.1.0):**
```json
{
  "sessionId": "V1StGXR8_Z5jdHi6B-myT",
  "result": "To optimize React rendering performance...",
  "warning": null
}
```

**Migration steps:**
1. Update any code that parses the response to extract `result` from the JSON
2. Optionally use `sessionId` for conversation continuity
3. Check for `warning` field for compaction status

**Note:** The `web-search-batch` tool response format is unchanged.

### From v0.x (multi-model) to v1.0.0

If you're upgrading from a version that supported multiple models (GPT-5, O3, O4-mini):

1. **Remove `OPENAI_MODEL` environment variable** - GPT-5.5 is now the only supported model
2. **Update reasoning effort** - If you previously used `minimal`, switch to `none`; `xhigh` is available for hardest tasks
3. **Review system prompt** - Now optimized specifically for GPT-5.5 characteristics
4. **Check batch output** - Enhanced structured format with better presentation

## Requirements

- Node.js 16 or higher
- OpenAI API key with GPT-5.5 access
- MCP-compatible client (Claude Desktop, Claude Code, etc.)

## License

MIT

## Contributing

Issues and pull requests are welcome! Please see the [GitHub repository](https://github.com/atksh/oai-search-mcp) for details.

## Acknowledgments

Built with:
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) by Anthropic
- [OpenAI API](https://openai.com/api/) for GPT-5.5 access

Optimized based on [OpenAI's GPT-5.5 Prompting Guide](https://developers.openai.com/api/docs/guides/prompt-guidance?model=gpt-5.5).
