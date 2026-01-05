#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { nanoid } from "nanoid";

// =============================================================================
// Logger Implementation
// =============================================================================

type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  private level: LogLevel;
  private static readonly levelOrder: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
  };

  constructor(level: LogLevel = "info") {
    this.level = level;
  }

  private shouldLog(level: LogLevel): boolean {
    return Logger.levelOrder[level] >= Logger.levelOrder[this.level];
  }

  log(level: LogLevel, event: string, metadata?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...metadata,
    };
    console.error(JSON.stringify(entry));
  }

  debug(event: string, meta?: Record<string, unknown>) {
    this.log("debug", event, meta);
  }
  info(event: string, meta?: Record<string, unknown>) {
    this.log("info", event, meta);
  }
  warn(event: string, meta?: Record<string, unknown>) {
    this.log("warn", event, meta);
  }
  error(event: string, meta?: Record<string, unknown>) {
    this.log("error", event, meta);
  }
}

// =============================================================================
// Session Management
// =============================================================================

interface Session {
  id: string;
  lastResponseId: string;
  createdAt: number;
  lastAccessAt: number;
  queryCount: number;
  totalTokens: number;
}

class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private ttl: number;
  private maxSessions: number;

  constructor(ttl = 7200000, maxSessions = 100) {
    this.ttl = ttl;
    this.maxSessions = maxSessions;
  }

  create(): Session {
    this.cleanup();
    const session: Session = {
      id: nanoid(),
      lastResponseId: "",
      createdAt: Date.now(),
      lastAccessAt: Date.now(),
      queryCount: 0,
      totalTokens: 0,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (session && Date.now() - session.lastAccessAt < this.ttl) {
      return session;
    }
    // TTL expired or not found
    if (session) {
      this.sessions.delete(id);
    }
    return undefined;
  }

  update(id: string, responseId: string, tokens: number): void {
    const session = this.sessions.get(id);
    if (session) {
      session.lastResponseId = responseId;
      session.lastAccessAt = Date.now();
      session.queryCount++;
      session.totalTokens += tokens;
    }
  }

  resetCounters(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.queryCount = 0;
      session.totalTokens = 0;
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastAccessAt >= this.ttl) {
        this.sessions.delete(id);
      }
    }
    // LRU eviction if over max
    while (this.sessions.size > this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        (a, b) => a[1].lastAccessAt - b[1].lastAccessAt
      )[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
  }
}

// Create server instance
const server = new McpServer({
  name: "oai-search-mcp",
  version: "1.0.0",
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

// Helper to parse boolean env vars
function parseBoolWithFallback(
  value: string | undefined,
  fallback: boolean
): boolean {
  if (!value) return fallback;
  return value.toLowerCase() === "true";
}

// Configuration from environment variables
const config = {
  apiKey: process.env.OPENAI_API_KEY,
  model: "gpt-5.2",
  maxRetries: parseIntWithFallback(process.env.OPENAI_MAX_RETRIES, 3),
  timeout: parseIntWithFallback(process.env.OPENAI_API_TIMEOUT, 300000),
  searchContextSize: (process.env.SEARCH_CONTEXT_SIZE || "medium") as
    | "low"
    | "medium"
    | "high",
  reasoningEffort: (process.env.REASONING_EFFORT || "medium") as
    | "none"
    | "low"
    | "medium"
    | "high"
    | "xhigh",
  outputVerbosity: (process.env.OUTPUT_VERBOSITY || "medium") as
    | "low"
    | "medium"
    | "high",
  systemPrompt: process.env.SYSTEM_PROMPT,
  // Session management
  sessionTtlMs: parseIntWithFallback(process.env.SESSION_TTL_MS, 7200000), // 2 hours
  maxSessions: parseIntWithFallback(process.env.MAX_SESSIONS, 100),
  // Compaction
  autoCompaction: parseBoolWithFallback(process.env.AUTO_COMPACTION, true),
  compactionQueryThreshold: parseIntWithFallback(
    process.env.COMPACTION_QUERY_THRESHOLD,
    10
  ),
  compactionTokenThreshold: parseIntWithFallback(
    process.env.COMPACTION_TOKEN_THRESHOLD,
    50000
  ),
  // Logging
  logLevel: (process.env.LOG_LEVEL || "info") as LogLevel,
};

// Initialize logger and session store
const logger = new Logger(config.logLevel);
const sessionStore = new SessionStore(config.sessionTtlMs, config.maxSessions);

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

// =============================================================================
// Compaction
// =============================================================================

function shouldCompact(session: Session): boolean {
  if (!config.autoCompaction) return false;
  if (!session.lastResponseId) return false;
  return (
    session.queryCount >= config.compactionQueryThreshold ||
    session.totalTokens >= config.compactionTokenThreshold
  );
}

async function compactConversation(
  session: Session
): Promise<{ success: boolean; newResponseId?: string }> {
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.debug("compaction_attempt", {
        sessionId: session.id,
        attempt,
        queryCount: session.queryCount,
        totalTokens: session.totalTokens,
      });

      // Use the compact method from SDK v6.15.0
      const compacted = await (openai.responses as any).compact({
        model: config.model,
        previous_response_id: session.lastResponseId,
      });

      logger.info("compaction_success", {
        sessionId: session.id,
        attempt,
        newResponseId: compacted.id,
      });
      return { success: true, newResponseId: compacted.id };
    } catch (error) {
      logger.warn("compaction_retry", {
        sessionId: session.id,
        attempt,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.error("compaction_failed", {
    sessionId: session.id,
    queryCount: session.queryCount,
    totalTokens: session.totalTokens,
  });
  return { success: false };
}

// =============================================================================
// Search Execution
// =============================================================================

interface SearchResult {
  text: string;
  responseId: string;
  tokens: number;
}

// Helper function to execute a single search
async function executeSingleSearch(
  input: string,
  options?: {
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    searchContextSize?: "low" | "medium" | "high";
    outputVerbosity?: "low" | "medium" | "high";
    outputFormatInstruction?: string;
    previousResponseId?: string;
  }
): Promise<SearchResult> {
  const startTime = Date.now();
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

    const request: Record<string, unknown> = {
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
      store: true, // Always store for session continuity
    };

    if (instructions) {
      request.instructions = instructions;
    }

    // Add previous_response_id for session continuity
    if (options?.previousResponseId) {
      request.previous_response_id = options.previousResponseId;
    }

    logger.debug("api_request", {
      input: input.substring(0, 100),
      reasoningEffort,
      searchContextSize,
      hasPreviousResponseId: !!options?.previousResponseId,
    });

    const response = await openai.responses.create(request as any);
    const duration = Date.now() - startTime;
    const tokens = (response as any).usage?.total_tokens || 0;

    logger.info("api_response", {
      responseId: response.id,
      duration,
      tokens,
    });

    return {
      text: response.output_text || "No response text available.",
      responseId: response.id,
      tokens,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error("api_error", {
      error: error instanceof Error ? error.message : String(error),
      duration,
    });

    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    // Provide more helpful error messages for common issues
    let errorText: string;
    if (errorMessage.includes("api_key")) {
      errorText = `Error: Invalid API key. Please check your OPENAI_API_KEY environment variable.`;
    } else if (errorMessage.includes("rate_limit")) {
      errorText = `Error: Rate limit exceeded. Please try again later.`;
    } else if (errorMessage.includes("timeout")) {
      errorText = `Error: Request timeout. The search took too long to complete.`;
    } else {
      errorText = `Error: ${errorMessage}`;
    }

    return {
      text: errorText,
      responseId: "",
      tokens: 0,
    };
  }
}

// Legacy wrapper for backward compatibility with batch search
async function executeSingleSearchLegacy(
  input: string,
  options?: {
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
    searchContextSize?: "low" | "medium" | "high";
    outputVerbosity?: "low" | "medium" | "high";
    outputFormatInstruction?: string;
  }
): Promise<string> {
  const result = await executeSingleSearch(input, options);
  return result.text;
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

The tool supports natural language queries and can search across documentation, GitHub issues, Stack Overflow, and other technical resources.

Session Support:
- If sessionId is omitted, a new session is automatically created
- Pass the returned sessionId in subsequent requests to maintain conversation context
- Sessions expire after 2 hours of inactivity (configurable via SESSION_TTL_MS)
- Invalid or expired sessionId will return an error`,
  {
    input: z
      .string()
      .describe(
        "Your search query or question in natural language. Examples: 'How to fix React useState error', 'Latest TypeScript 5.0 features', 'Best practices for error handling in Node.js', 'OpenAI API rate limits and pricing'."
      ),
    sessionId: z
      .string()
      .optional()
      .describe(
        "Session ID for conversation continuity. If omitted, a new session is created. Pass the sessionId from a previous response to continue the conversation with context."
      ),
    reasoningEffort: z
      .enum(["none", "low", "medium", "high", "xhigh"])
      .optional()
      .describe(
        "Reasoning effort level: 'none' (no reasoning, fastest), 'low' (quick analysis), 'medium' (balanced, recommended), 'high' (thorough, slower), 'xhigh' (maximum deliberation for hardest tasks). Higher values provide deeper analysis but increase latency/cost. Use 'none' for low-latency tasks, 'xhigh' only when needed."
      ),
    searchContextSize: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Search context size: 'low' (fewer results, faster), 'medium' (balanced, recommended), 'high' (most comprehensive, slower). Higher values retrieve more search results and context for better coverage of the topic."
      ),
    outputVerbosity: z
      .enum(["low", "medium", "high"])
      .optional()
      .describe(
        "Output verbosity: 'low' (concise, brief answers), 'medium' (balanced, recommended), 'high' (comprehensive with full context). Use 'low' for quick answers, 'high' for detailed explanations with examples."
      ),
    outputFormatInstruction: z
      .string()
      .optional()
      .describe(
        "Custom format instructions for the response. Examples: 'Format as a bulleted list', 'Use JSON format', 'Provide code examples with explanations', 'Create a comparison table', 'Structure as FAQ format'. This is appended to the system prompt to control output structure."
      ),
  },
  async ({
    input,
    sessionId,
    reasoningEffort,
    searchContextSize,
    outputVerbosity,
    outputFormatInstruction,
  }: {
    input: string;
    sessionId?: string | undefined;
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | undefined;
    searchContextSize?: "low" | "medium" | "high" | undefined;
    outputVerbosity?: "low" | "medium" | "high" | undefined;
    outputFormatInstruction?: string | undefined;
  }) => {
    logger.debug("web_search_request", {
      inputLength: input.length,
      sessionId: sessionId ?? "new",
      reasoningEffort,
      searchContextSize,
    });

    // Handle session
    let session: Session | undefined;
    let warning: string | undefined;

    if (sessionId) {
      // Validate existing session
      session = sessionStore.get(sessionId);
      if (!session) {
        logger.warn("invalid_session", { sessionId });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  sessionId: null,
                  result: null,
                  error: `Invalid or expired session ID: ${sessionId}`,
                },
                null,
                2
              ),
            },
          ],
          isError: true,
        };
      }
    } else {
      // Create new session
      session = sessionStore.create();
      logger.info("session_created", { sessionId: session.id });
    }

    // Check if compaction is needed (before request)
    if (shouldCompact(session)) {
      logger.info("compaction_triggered", {
        sessionId: session.id,
        queryCount: session.queryCount,
        totalTokens: session.totalTokens,
      });
      const compactResult = await compactConversation(session);
      if (compactResult.success && compactResult.newResponseId) {
        session.lastResponseId = compactResult.newResponseId;
        sessionStore.resetCounters(session.id);
      } else {
        warning = "Compaction failed, continuing without compression";
      }
    }

    // Build search options
    const options: {
      reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
      searchContextSize?: "low" | "medium" | "high";
      outputVerbosity?: "low" | "medium" | "high";
      outputFormatInstruction?: string;
      previousResponseId?: string;
    } = {};

    if (reasoningEffort !== undefined) options.reasoningEffort = reasoningEffort;
    if (searchContextSize !== undefined)
      options.searchContextSize = searchContextSize;
    if (outputVerbosity !== undefined) options.outputVerbosity = outputVerbosity;
    if (outputFormatInstruction !== undefined)
      options.outputFormatInstruction = outputFormatInstruction;

    // Add previous response ID for session continuity
    if (session.lastResponseId) {
      options.previousResponseId = session.lastResponseId;
    }

    // Execute search
    const result = await executeSingleSearch(input, options);

    // Update session with response
    if (result.responseId) {
      sessionStore.update(session.id, result.responseId, result.tokens);
    }

    logger.info("web_search_complete", {
      sessionId: session.id,
      queryCount: session.queryCount,
      totalTokens: session.totalTokens,
    });

    // Return JSON response
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              sessionId: session.id,
              result: result.text,
              ...(warning && { warning }),
            },
            null,
            2
          ),
        },
      ],
    };
  }
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
      .enum(["none", "low", "medium", "high", "xhigh"])
      .optional()
      .describe(
        "Reasoning effort level applied to all queries in the batch: 'none' (fastest), 'low' (quick analysis), 'medium' (balanced, recommended), 'high' (thorough), 'xhigh' (maximum deliberation). Higher values increase processing time/cost for all queries.",
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
    reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh" | undefined;
    searchContextSize?: "low" | "medium" | "high" | undefined;
    outputVerbosity?: "low" | "medium" | "high" | undefined;
    outputFormatInstruction?: string | undefined;
    outputFormat?: "structured" | "plain" | "json" | undefined;
  }) => {
    try {
      // Execute all searches in parallel with shared options
	      const searchOptions: {
	        reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
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

      // Execute searches with individual error handling (using legacy function for batch)
      const results = await Promise.allSettled(
        inputs.map((input) => executeSingleSearchLegacy(input, searchOptions))
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
        // Structured format: separate content blocks with enhanced presentation (default)
        const contentBlocks: Array<{
          type: "text";
          text: string;
        }> = [];

        // Calculate statistics
        const successCount = results.filter((r) => r.status === "fulfilled").length;
        const errorCount = results.filter((r) => r.status === "rejected").length;
        const successRate = ((successCount / inputs.length) * 100).toFixed(1);

        // Add executive summary header with enhanced formatting
        const summaryHeader = [
          "# 🔍 Batch Search Results",
          "",
          "## Overview",
          "",
          `- **Total Queries**: ${inputs.length}`,
          `- **Successful**: ${successCount} ✓`,
          errorCount > 0 ? `- **Failed**: ${errorCount} ✗` : "",
          `- **Success Rate**: ${successRate}%`,
          "",
          "## Queries",
          "",
          inputs.map((query, idx) => `${idx + 1}. ${query}`).join("\n"),
          "",
          "---",
          "",
        ].filter(line => line !== "").join("\n");

        contentBlocks.push({
          type: "text",
          text: summaryHeader,
        });

        // Add individual results with enhanced formatting
        results.forEach((result, index) => {
          const queryNumber = index + 1;
          const totalQueries = inputs.length;
          
          if (result.status === "fulfilled") {
            const resultText = [
              `## 📋 Result ${queryNumber}/${totalQueries}`,
              "",
              `**Query**: ${inputs[index]}`,
              "",
              `**Status**: ✓ Success`,
              "",
              "### Response",
              "",
              result.value,
              "",
              "---",
              "",
            ].join("\n");
            
            contentBlocks.push({
              type: "text",
              text: resultText,
            });
          } else {
            const errorMsg =
              result.reason instanceof Error
                ? result.reason.message
                : String(result.reason);
            
            const errorText = [
              `## 📋 Result ${queryNumber}/${totalQueries}`,
              "",
              `**Query**: ${inputs[index]}`,
              "",
              `**Status**: ✗ Failed`,
              "",
              "### Error Details",
              "",
              `\`\`\``,
              errorMsg,
              `\`\`\``,
              "",
              "---",
              "",
            ].join("\n");
            
            contentBlocks.push({
              type: "text",
              text: errorText,
            });
          }
        });

        // Add completion footer
        contentBlocks.push({
          type: "text",
          text: `## Summary\n\nCompleted ${successCount} out of ${inputs.length} queries successfully.${errorCount > 0 ? ` ${errorCount} query(ies) encountered errors.` : " All queries completed without errors."}`,
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
