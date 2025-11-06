# oai-search-mcp (gpt-5, o4-mini support)

MCP server that enables the use of OpenAI's high-end models and their powerful web search capabilities.
By registering it with any AI coding agent, the agent can autonomously consult with OpenAI models to solve complex problems.


## Use Cases

### 🐛 When you're stuck debugging

oai's web search can scan a wide range of sources, including GitHub issues and Stack Overflow, significantly increasing the chances of resolving niche problems. Example prompts:

```
> I'm getting the following error on startup, please fix it. If it's too difficult, ask oai.
> [Paste error message here]
```
```
> The WebSocket connection isn't working. Please debug it. If you don't know how, ask oai.
```

### 📚 When you want to reference the latest library information

You can get answers from the powerful web search even when there's no well-organized documentation. Example prompts:

```
> I want to upgrade this library to v2. Proceed while consulting with oai.
```

```
> I was told this option for this library doesn't exist. It might have been removed. Ask oai what to specify instead and replace it.
```

### 🧩 When tackling complex tasks

In addition to search, you can also use it as a sounding board for design. Example prompts:

```
> I want to create a collaborative editor, so please design it. Also, ask oai for a design review and discuss if necessary.
```

Also, since it's provided as an MCP server, the AI agent may decide on its own to talk to oai when it deems it necessary, without any instructions from you. This will dramatically expand the range of problems it can solve on its own!

## Installation

### npx (Recommended)

Claude Code:

```sh
$ claude mcp add oai \
	-s user \  # If you omit this line, it will be installed in the project scope
	-e OPENAI_MODEL=gpt-5 \ # o4-mini, gpt-5 also available
	-e OPENAI_API_KEY=your-api-key \
	-e SEARCH_CONTEXT_SIZE=medium \
	-e REASONING_EFFORT=medium \
  -e OUTPUT_VERBOSITY=high \
  -e SYSTEM_PROMPT="You are a helpful assistant." \
	-e OPENAI_API_TIMEOUT=300000 \
	-e OPENAI_MAX_RETRIES=3 \
	-- npx oai-search-mcp
```

json:

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "npx",
      "args": ["oai-search-mcp"],
      "env": {
        "OPENAI_API_KEY": "your-api-key",
        // Optional: o3, o4-mini, gpt-5 (default: gpt-5)
        "OPENAI_MODEL": "gpt-5",
        // Optional: low, medium, high (default: medium)
        "SEARCH_CONTEXT_SIZE": "medium",
        "REASONING_EFFORT": "medium",
        // Optional: API timeout in milliseconds (default: 300000)
        "OPENAI_API_TIMEOUT": "300000",
        // Optional: Maximum number of retries (default: 3)
        "OPENAI_MAX_RETRIES": "3",
        // Optional: Output verbosity (default: high)
        "OUTPUT_VERBOSITY": "high",
        // Optional: Custom system prompt
        "SYSTEM_PROMPT": "You are a helpful assistant."
      }
    }
  }
}
```

### Local Setup

If you want to download the code and run it locally:

```bash
git clone git@github.com:atksh/oai-search-mcp.git
cd oai-search-mcp
pnpm install
pnpm build
```

Claude Code:

```sh
$ claude mcp add oai \
	-s user \  # If you omit this line, it will be installed in the project scope
	-e OPENAI_MODEL=gpt-5 \ # o4-mini, gpt-5 also available
	-e OPENAI_API_KEY=your-api-key \
	-e SEARCH_CONTEXT_SIZE=medium \
	-e REASONING_EFFORT=medium \
  -e OUTPUT_VERBOSITY=high \
	-e OPENAI_API_TIMEOUT=300000 \
	-e OPENAI_MAX_RETRIES=3 \
	-- node /path/to/oai-search-mcp/build/index.js
```

json:

```jsonc
{
  "mcpServers": {
    "oai-search": {
      "command": "node",
      "args": ["/path/to/oai-search-mcp/build/index.js"],
      "env": {
        "OPENAI_API_KEY": "your-api-key",
        // Optional: o3, o4-mini, gpt-5 (default: gpt-5)
        "OPENAI_MODEL": "gpt-5",
        // Optional: low, medium, high (default: medium)
        "SEARCH_CONTEXT_SIZE": "medium",
        "REASONING_EFFORT": "medium",
        // Optional: API timeout in milliseconds (default: 300000)
        "OPENAI_API_TIMEOUT": "300000",
        // Optional: Maximum number of retries (default: 3)
        "OPENAI_MAX_RETRIES": "3",
        // Optional: Output verbosity (default: high)
        "OUTPUT_VERBOSITY": "high",
        // Optional: Custom system prompt
        "SYSTEM_PROMPT": "You are a helpful assistant."
      }
    }
  }
}
```

## Environment Variables

| Environment Variable | Options | Default | Description |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | Required | - | OpenAI API Key |
| `OPENAI_MODEL` | Optional | `gpt-5` | Model to use<br>Values: `o3`, `o4-mini`, `gpt-5` |
| `SEARCH_CONTEXT_SIZE` | Optional | `medium` | Controls the search context size<br>Values: `low`, `medium`, `high` |
| `REASONING_EFFORT` | Optional | `medium` | Controls the reasoning effort level<br>Values: `low`, `medium`, `high` |
| `OPENAI_API_TIMEOUT` | Optional | `300000` | API request timeout in milliseconds<br>Example: `300000` for 5 minutes |
| `OPENAI_MAX_RETRIES` | Optional | `3` | Maximum number of retries for failed requests<br>The SDK automatically retries on rate limits (429), server errors (5xx), and connection errors |
| `OUTPUT_VERBOSITY` | Optional | `medium` | Controls the output verbosity<br>Values: `low`, `medium`, `high` |
| `SYSTEM_PROMPT` | Optional | - | Custom system prompt<br>If not provided, the default system prompt will be used |

