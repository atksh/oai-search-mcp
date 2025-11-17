# oai-search-mcp (GPT-5.1)

MCP server that enables AI agents to leverage OpenAI's GPT-5.1 model with powerful web search capabilities. By registering this server with any AI coding agent, the agent can autonomously consult GPT-5.1 to solve complex problems through intelligent web searches.

## Why GPT-5.1?

GPT-5.1 is OpenAI's latest flagship model, optimized for:

- **Better calibrated reasoning**: Consumes fewer tokens on simple queries while efficiently handling complex ones
- **Improved steerability**: More control over personality, tone, and output formatting
- **Low-latency option**: New `none` reasoning mode for fast responses when reasoning isn't needed
- **Enhanced intelligence**: Superior instruction-following and better balance of speed and quality

## Use Cases

### 🐛 When You're Stuck Debugging

GPT-5.1's web search can scan GitHub issues, Stack Overflow, and documentation to find solutions for niche problems.

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

Use GPT-5.1 not just for search, but as a design consultant and problem-solving partner.

**Example prompts:**
```
> I want to create a collaborative editor. Please design it and ask oai for a design review.
```

The AI agent may autonomously decide to consult GPT-5.1 when it deems necessary, dramatically expanding the range of problems it can solve independently!

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
        // Optional: none, low, medium, high (default: medium)
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
| `REASONING_EFFORT` | No | `medium` | GPT-5.1 reasoning effort level<br>**Values**: `none`, `low`, `medium`, `high`<br>`none`: No reasoning, fastest (for low-latency tasks)<br>`low`: Quick analysis<br>`medium`: Balanced (recommended)<br>`high`: Most thorough, slower |
| `OUTPUT_VERBOSITY` | No | `medium` | Response detail level<br>**Values**: `low`, `medium`, `high`<br>`low`: Concise answers<br>`medium`: Balanced detail<br>`high`: Comprehensive with full context |
| `OPENAI_API_TIMEOUT` | No | `300000` | API request timeout in milliseconds<br>Default: 300000 (5 minutes) |
| `OPENAI_MAX_RETRIES` | No | `3` | Maximum retries for failed requests<br>The SDK automatically retries on rate limits (429), server errors (5xx), and connection errors |
| `SYSTEM_PROMPT` | No | _(default)_ | Custom system prompt for response style<br>If not provided, uses the built-in prompt optimized for GPT-5.1 |

## Features

### 🔍 Single Web Search

Execute a single intelligent web search with GPT-5.1:

```typescript
// Tool: web-search
{
  "input": "How to optimize React rendering performance?",
  "reasoningEffort": "medium",
  "searchContextSize": "high",
  "outputVerbosity": "high"
}
```

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

## GPT-5.1 Optimizations

This MCP server is specifically optimized for GPT-5.1's characteristics:

### Persistence and Completeness

The default system prompt emphasizes completeness to counter GPT-5.1's tendency toward over-conciseness. Responses prioritize thoroughness while maintaining relevance.

### Adaptive Verbosity

Responses automatically adapt detail level to query complexity:
- **Simple queries**: 2-4 concise paragraphs
- **Medium queries**: 4-8 paragraphs with structured sections
- **Complex queries**: Comprehensive multi-section responses with examples

### None Reasoning Mode

Use `REASONING_EFFORT=none` for low-latency tasks that don't require deep analysis:
- Quick fact lookups
- Simple documentation searches
- Status checks
- Straightforward questions

Use `medium` or `high` for:
- Complex problem solving
- Multi-step analysis
- Design decisions
- Debugging difficult issues

## Tips for Best Results

1. **Be specific in queries**: "How to fix React useState closure issue" works better than "React problem"
2. **Use batch search for comparisons**: Compare multiple options simultaneously for consistent analysis
3. **Adjust reasoning effort**: Use `none` for speed, `high` for difficult problems
4. **Leverage verbosity control**: Set `low` for quick answers, `high` for learning in-depth
5. **Customize the system prompt**: Tailor response style to your team's needs

## Migration from Earlier Versions

If you're upgrading from a version that supported multiple models (GPT-5, O3, O4-mini):

1. **Remove `OPENAI_MODEL` environment variable** - GPT-5.1 is now the only supported model
2. **Update reasoning effort** - New `none` option available for low-latency use cases
3. **Review system prompt** - Now optimized specifically for GPT-5.1 characteristics
4. **Check batch output** - Enhanced structured format with better presentation

## Requirements

- Node.js 16 or higher
- OpenAI API key with GPT-5.1 access
- MCP-compatible client (Claude Desktop, Claude Code, etc.)

## License

MIT

## Contributing

Issues and pull requests are welcome! Please see the [GitHub repository](https://github.com/atksh/oai-search-mcp) for details.

## Acknowledgments

Built with:
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) by Anthropic
- [OpenAI API](https://openai.com/api/) for GPT-5.1 access

Optimized based on [OpenAI's GPT-5.1 Prompting Guide](https://cookbook.openai.com/examples/gpt-5/gpt-5-1_prompting_guide).
