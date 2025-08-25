#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Create server instance
const server = new McpServer({
  name: "oai-search-mcp",
  version: "0.0.2",
});

// Configuration from environment variables
const config = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-5",
  maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES || "3"),
  timeout: parseInt(process.env.OPENAI_API_TIMEOUT || "300000"),
  searchContextSize: (process.env.SEARCH_CONTEXT_SIZE || "medium") as
    | "low"
    | "medium"
    | "high",
  reasoningEffort: (process.env.REASONING_EFFORT || "medium") as
    | "minimal"
    | "low"
    | "medium"
    | "high",
  outputVerbosity: (process.env.OUTPUT_VERBOSITY || "high") as
    | "low"
    | "medium"
    | "high",
  systemPrompt: process.env.SYSTEM_PROMPT,
};

// Resolve default system prompt from markdown file when env not provided
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const defaultPromptCandidates = [
  path.resolve(__dirname, "SYSTEM_PROMPT.md"),
  path.resolve(__dirname, "..", "SYSTEM_PROMPT.md"),
];

function readDefaultSystemPrompt(): string | undefined {
  for (const candidate of defaultPromptCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        const content = fs.readFileSync(candidate, "utf8");
        if (content && content.trim().length > 0) return content;
      }
    } catch {
      // ignore read errors and try next candidate
    }
  }
  return undefined;
}

if (!config.systemPrompt) {
  const filePrompt = readDefaultSystemPrompt();
  if (filePrompt) config.systemPrompt = filePrompt;
}

// Initialize OpenAI client with retry and timeout configuration
const openai = new OpenAI({
  apiKey: config.apiKey,
  maxRetries: config.maxRetries,
  timeout: config.timeout,
});

// Define the o3-search tool
server.tool(
  "oai-search",
  `An AI agent with advanced web search capabilities. Useful for finding the latest information, troubleshooting errors, and discussing ideas or design challenges. Supports natural language queries.`,
  {
    input: z
      .string()
      .describe(
        "Ask questions, search for information, or consult about complex problems in English.",
      ),
  },
  async ({ input }: { input: string }) => {
    try {
      const request = {
        model: config.model,
        input,
        tools: [
          {
            type: "web_search_preview",
            search_context_size: config.searchContextSize,
          },
        ],
        tool_choice: "auto" as const,
        parallel_tool_calls: true,
        reasoning: { effort: config.reasoningEffort },
      } as Record<string, unknown>;

      if (config.systemPrompt) {
        request.instructions = config.systemPrompt;
      }

      const response = await openai.responses.create(request as any);

      return {
        content: [
          {
            type: "text",
            text: response.output_text || "No response text available.",
          },
        ],
      };
    } catch (error) {
      console.error("Error calling OpenAI API:", error);
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
