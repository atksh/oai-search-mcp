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
  version: "0.0.1",
});

// Helper function to safely parse integer with fallback
function parseIntWithFallback(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// Configuration from environment variables
const config = {
  apiKey: process.env.OPENAI_API_KEY,
  model: process.env.OPENAI_MODEL || "gpt-5",
  maxRetries: parseIntWithFallback(process.env.OPENAI_MAX_RETRIES, 3),
  timeout: parseIntWithFallback(process.env.OPENAI_API_TIMEOUT, 300000),
  searchContextSize: (process.env.SEARCH_CONTEXT_SIZE || "medium") as
    | "low"
    | "medium"
    | "high",
  reasoningEffort: (process.env.REASONING_EFFORT || "medium") as
    | "minimal"
    | "low"
    | "medium"
    | "high",
  outputVerbosity: (process.env.OUTPUT_VERBOSITY || "medium") as
    | "low"
    | "medium"
    | "high",
  systemPrompt: process.env.SYSTEM_PROMPT,
};

// Validate API key
if (!config.apiKey) {
  console.error(
    "Error: OPENAI_API_KEY environment variable is required but not set.",
  );
  process.exit(1);
}

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

// Helper function to execute a single search
async function executeSingleSearch(
  input: string,
  options?: {
    reasoningEffort?: "minimal" | "low" | "medium" | "high";
    searchContextSize?: "low" | "medium" | "high";
    outputVerbosity?: "low" | "medium" | "high";
    outputFormatInstruction?: string;
  },
): Promise<string> {
  try {
    const reasoningEffort = options?.reasoningEffort ?? config.reasoningEffort;
    const searchContextSize =
      options?.searchContextSize ?? config.searchContextSize;
    const outputVerbosity = options?.outputVerbosity ?? config.outputVerbosity;
    const outputFormatInstruction = options?.outputFormatInstruction;

    // Build instructions from system prompt and optional format instruction
    let instructions = config.systemPrompt ?? "";
    if (outputFormatInstruction) {
      instructions = instructions
        ? `${instructions}\n\n${outputFormatInstruction}`
        : outputFormatInstruction;
    }

    // Add verbosity instruction if specified
    if (outputVerbosity) {
      const verbosityInstruction = `Output verbosity level: ${outputVerbosity}. ${
        outputVerbosity === "low"
          ? "Provide concise, brief responses."
          : outputVerbosity === "medium"
            ? "Provide balanced, moderately detailed responses."
            : "Provide comprehensive, detailed responses with full context."
      }`;
      instructions = instructions
        ? `${instructions}\n\n${verbosityInstruction}`
        : verbosityInstruction;
    }

    const request = {
      model: config.model,
      input,
      tools: [
        {
          type: "web_search_preview",
          search_context_size: searchContextSize,
        },
      ],
      tool_choice: "auto" as const,
      parallel_tool_calls: true,
      reasoning: { effort: reasoningEffort },
    } as Record<string, unknown>;

    if (instructions) {
      request.instructions = instructions;
    }

    const response = await openai.responses.create(request as any);
    return response.output_text || "No response text available.";
  } catch (error) {
    console.error("Error calling OpenAI API:", error);
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    // Provide more helpful error messages for common issues
    if (errorMessage.includes("api_key")) {
      return `Error: Invalid API key. Please check your OPENAI_API_KEY environment variable.`;
    }
    if (errorMessage.includes("rate_limit")) {
      return `Error: Rate limit exceeded. Please try again later.`;
    }
    if (errorMessage.includes("timeout")) {
      return `Error: Request timeout. The search took too long to complete.`;
    }
    return `Error: ${errorMessage}`;
  }
}

// Define the single search tool
server.tool(
  "web-search",
  `Perform a single web search using OpenAI's advanced search capabilities. This tool uses powerful AI models to search the web, analyze results, and provide comprehensive answers to your queries.

Use this tool when you need to:
- Find the latest information on a topic
- Troubleshoot errors or technical issues
- Research libraries, frameworks, or APIs
- Get design recommendations or best practices
- Understand complex concepts or technologies

The tool supports natural language queries and can search across documentation, GitHub issues, Stack Overflow, and other technical resources.`,
  {
    input: z
      .string()
      .describe(
        "Your search query or question in natural language. Examples: 'How to fix React useState error', 'Latest TypeScript 5.0 features', 'Best practices for error handling in Node.js', 'OpenAI API rate limits and pricing'.",
      ),
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high"])
      .optional()
      .describe(
        "Reasoning effort level: 'minimal' (fastest, basic analysis), 'low' (quick analysis), 'medium' (balanced, recommended), 'high' (most thorough, slower). Higher values provide deeper analysis but take longer. Use 'high' for complex problems requiring comprehensive reasoning.",
      ),
    searchContextSize: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Search context size: 'low' (fewer results, faster), 'medium' (balanced, recommended), 'high' (most comprehensive, slower). Higher values retrieve more search results and context for better coverage of the topic.",
      ),
    outputVerbosity: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Output verbosity: 'low' (concise, brief answers), 'medium' (balanced, recommended), 'high' (comprehensive with full context). Use 'low' for quick answers, 'high' for detailed explanations with examples.",
      ),
    outputFormatInstruction: z
      .string()
      .optional()
      .describe(
        "Custom format instructions for the response. Examples: 'Format as a bulleted list', 'Use JSON format', 'Provide code examples with explanations', 'Create a comparison table', 'Structure as FAQ format'. This is appended to the system prompt to control output structure.",
      ),
  },
  async ({
    input,
    reasoningEffort,
    searchContextSize,
    outputVerbosity,
    outputFormatInstruction,
  }: {
    input: string;
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | undefined;
    searchContextSize?: "low" | "medium" | "high" | undefined;
    outputVerbosity?: "low" | "medium" | "high" | undefined;
    outputFormatInstruction?: string | undefined;
  }) => {
    const options: {
      reasoningEffort?: "minimal" | "low" | "medium" | "high";
      searchContextSize?: "low" | "medium" | "high";
      outputVerbosity?: "low" | "medium" | "high";
      outputFormatInstruction?: string;
    } = {};
    if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
    if (searchContextSize !== undefined)
      options.searchContextSize = searchContextSize;
    if (outputVerbosity !== undefined) options.outputVerbosity = outputVerbosity;
    if (outputFormatInstruction !== undefined)
      options.outputFormatInstruction = outputFormatInstruction;
    const result = await executeSingleSearch(input, options);
    return {
      content: [
        {
          type: "text",
          text: result,
        },
      ],
    };
  },
);

// Define the batch search tool for parallel execution
server.tool(
  "web-search-batch",
  `Execute multiple web searches in parallel for efficiency. This tool accepts an array of queries and processes them simultaneously, significantly reducing total execution time compared to sequential searches.

Use this tool when you need to:
- Research multiple related topics at once
- Compare different technologies or approaches
- Gather information from various angles on the same subject
- Perform independent searches that don't depend on each other

All queries are executed concurrently, and results are returned in the same order as the input array. The specified options (reasoning effort, search context size, verbosity, format) are applied uniformly to all queries in the batch.

The tool supports multiple output formats:
- 'structured' (default): Each query result is returned as a separate content block with metadata, making it easy to parse and process individual results
- 'plain': All results combined into a single text block (backward compatible)
- 'json': Structured JSON format with status, query, result, and error fields for programmatic processing

Error handling: Individual query failures don't stop the batch; each query's result or error is included in the output.`,
  {
    inputs: z
      .array(z.string())
      .describe(
        "Array of search queries to execute in parallel. Each query should be independent and can be processed concurrently. Results are returned in the same order as this array. Maximum 10 queries per batch. Example: ['React hooks best practices', 'Vue 3 composition API', 'Angular dependency injection'].",
      )
      .min(1)
      .max(10),
    reasoningEffort: z
      .enum(["minimal", "low", "medium", "high"])
      .optional()
      .describe(
        "Reasoning effort level applied to all queries in the batch: 'minimal' (fastest, basic analysis), 'low' (quick analysis), 'medium' (balanced, recommended), 'high' (most thorough, slower). Higher values provide deeper analysis but increase processing time for all queries.",
      ),
    searchContextSize: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Search context size applied to all queries: 'low' (fewer results, faster), 'medium' (balanced, recommended), 'high' (most comprehensive, slower). Higher values retrieve more search results and context for better coverage across all queries.",
      ),
    outputVerbosity: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Output verbosity applied to all queries: 'low' (concise, brief answers), 'medium' (balanced, recommended), 'high' (comprehensive with full context). Use 'low' for quick summaries, 'high' for detailed explanations with examples for each query.",
      ),
    outputFormatInstruction: z
      .string()
      .optional()
      .describe(
        "Custom format instructions applied to all query responses. Examples: 'Format as a bulleted list', 'Use JSON format', 'Provide code examples with explanations', 'Create a comparison table'. This instruction is applied uniformly to format the output for each query in the batch.",
      ),
    outputFormat: z
      .enum(["structured", "plain", "json"])
      .optional()
      .describe(
        "Output format for batch results: 'structured' (each query result as separate content block with metadata, recommended), 'plain' (single combined text), 'json' (structured JSON format). Default: 'structured'.",
      ),
  },
  async ({
    inputs,
    reasoningEffort,
    searchContextSize,
    outputVerbosity,
    outputFormatInstruction,
    outputFormat = "structured",
  }: {
    inputs: string[];
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | undefined;
    searchContextSize?: "low" | "medium" | "high" | undefined;
    outputVerbosity?: "low" | "medium" | "high" | undefined;
    outputFormatInstruction?: string | undefined;
    outputFormat?: "structured" | "plain" | "json" | undefined;
  }) => {
    try {
      // Execute all searches in parallel with shared options
      const searchOptions: {
        reasoningEffort?: "minimal" | "low" | "medium" | "high";
        searchContextSize?: "low" | "medium" | "high";
        outputVerbosity?: "low" | "medium" | "high";
        outputFormatInstruction?: string;
      } = {};
      if (reasoningEffort !== undefined)
        searchOptions.reasoningEffort = reasoningEffort;
      if (searchContextSize !== undefined)
        searchOptions.searchContextSize = searchContextSize;
      if (outputVerbosity !== undefined)
        searchOptions.outputVerbosity = outputVerbosity;
      if (outputFormatInstruction !== undefined)
        searchOptions.outputFormatInstruction = outputFormatInstruction;

      // Execute searches with individual error handling
      const results = await Promise.allSettled(
        inputs.map((input) => executeSingleSearch(input, searchOptions)),
      );

      // Process results based on output format
      if (outputFormat === "json") {
        // JSON format: structured data
        const structuredResults = results.map((result, index) => ({
          query: inputs[index],
          index: index + 1,
          status: result.status === "fulfilled" ? "success" : "error",
          result: result.status === "fulfilled" ? result.value : null,
          error:
            result.status === "rejected"
              ? result.reason instanceof Error
                ? result.reason.message
                : String(result.reason)
              : null,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(structuredResults, null, 2),
            },
          ],
        };
      } else if (outputFormat === "plain") {
        // Plain format: single combined text
        const formattedResults = results
          .map((result, index) => {
            if (result.status === "fulfilled") {
              return `## Query ${index + 1}: ${inputs[index]}\n\n${result.value}\n`;
            } else {
              const errorMsg =
                result.reason instanceof Error
                  ? result.reason.message
                  : String(result.reason);
              return `## Query ${index + 1}: ${inputs[index]}\n\nError: ${errorMsg}\n`;
            }
          })
          .join("\n---\n\n");

        return {
          content: [
            {
              type: "text",
              text: formattedResults,
            },
          ],
        };
      } else {
        // Structured format: separate content blocks (default)
        const contentBlocks: Array<{
          type: "text";
          text: string;
        }> = [];

        // Add summary header
        const successCount = results.filter((r) => r.status === "fulfilled").length;
        const errorCount = results.filter((r) => r.status === "rejected").length;
        contentBlocks.push({
          type: "text",
          text: `# Batch Search Results\n\nTotal queries: ${inputs.length}\nSuccessful: ${successCount}\nFailed: ${errorCount}\n\n---\n\n`,
        });

        // Add individual results as separate blocks
        results.forEach((result, index) => {
          if (result.status === "fulfilled") {
            contentBlocks.push({
              type: "text",
              text: `## Query ${index + 1}: ${inputs[index]}\n\n${result.value}\n`,
            });
          } else {
            const errorMsg =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            contentBlocks.push({
              type: "text",
              text: `## Query ${index + 1}: ${inputs[index]}\n\n❌ Error: ${errorMsg}\n`,
            });
          }
        });

        return {
          content: contentBlocks,
        };
      }
    } catch (error) {
      console.error("Error in batch search:", error);
      return {
        content: [
          {
            type: "text",
            text: `Batch search error: ${error instanceof Error ? error.message : "Unknown error occurred"}`,
          },
        ],
      };
    }
  },
);

// Define MCP Resources
// Provide the system prompt as a resource for reference
server.resource(
  "system-prompt",
  "web-search://system-prompt",
  {
    name: "System Prompt",
    description: "System prompt used for web searches",
    mimeType: "text/markdown",
  },
  async () => {
    const systemPrompt = config.systemPrompt || readDefaultSystemPrompt() || "";
    return {
      contents: [
        {
          uri: "web-search://system-prompt",
          mimeType: "text/markdown",
          text: systemPrompt || "# System Prompt\n\nNo custom system prompt configured.",
        },
      ],
    };
  },
);

// Define MCP Prompts for common search patterns
server.prompt(
  "debug-error",
  "Debug and troubleshoot an error message",
  {
    error: z
      .string()
      .describe("The error message or stack trace to debug"),
    context: z
      .string()
      .optional()
      .describe("Additional context about when/where the error occurred"),
  },
  async ({ error, context }) => {
    const query = context
      ? `Debug this error: ${error}\n\nContext: ${context}\n\nPlease search for solutions, common causes, and fixes. Include code examples if available.`
      : `Debug this error: ${error}\n\nPlease search for solutions, common causes, and fixes. Include code examples if available.`;

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: query,
          },
        },
      ],
    };
  },
);

server.prompt(
  "compare-libraries",
  "Compare multiple libraries or technologies",
  {
    libraries: z
      .string()
      .describe("Comma-separated list of libraries or technologies to compare"),
    criteria: z
      .string()
      .optional()
      .describe("What to compare (e.g., 'performance, features, community support')"),
  },
  async ({ libraries, criteria }) => {
    const criteriaText = criteria
      ? ` Focus on: ${criteria}.`
      : " Compare performance, features, documentation quality, community support, and maintenance status.";
    const query = `Compare these libraries/technologies: ${libraries}.${criteriaText} Provide a structured comparison with pros and cons for each.`;

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: query,
          },
        },
      ],
    };
  },
);

server.prompt(
  "research-api",
  "Research an API or library documentation",
  {
    api: z.string().describe("The API or library name to research"),
    topic: z
      .string()
      .optional()
      .describe("Specific topic to research (e.g., 'authentication', 'rate limits', 'migration guide')"),
  },
  async ({ api, topic }) => {
    const topicText = topic ? ` Focus on: ${topic}.` : "";
    const query = `Research the ${api} API/library.${topicText} Find the latest documentation, usage examples, best practices, and any breaking changes or migration guides.`;

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: query,
          },
        },
      ],
    };
  },
);

server.prompt(
  "explore-documentation",
  "Explore and understand documentation for a technology",
  {
    technology: z
      .string()
      .describe("The technology, framework, or library to explore"),
    aspect: z
      .string()
      .optional()
      .describe("Specific aspect to explore (e.g., 'getting started', 'advanced features', 'architecture')"),
  },
  async ({ technology, aspect }) => {
    const aspectText = aspect ? ` Focus on: ${aspect}.` : "";
    const query = `Explore the documentation for ${technology}.${aspectText} Find official documentation, tutorials, examples, and community resources. Provide a comprehensive overview with key concepts and examples.`;

    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: query,
          },
        },
      ],
    };
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
