import type OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseFunctionWebSearch,
  ResponseInput,
  ResponseOutputItem,
  ResponseOutputMessage,
  ResponseOutputText,
  Tool,
} from "openai/resources/responses/responses";

export const MODEL = "gpt-6.1-terra" as const;
export const SEARCH_FUNCTION_NAME = "search_web" as const;
export const DEFAULT_MAX_SEARCH_CALLS = 5;
export const DEFAULT_MAX_PTC_ROUNDS = 8;

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";
export type SearchContextSize = "low" | "medium" | "high";
export type OutputVerbosity = "low" | "medium" | "high";

export interface Citation {
  title: string;
  url: string;
}

export interface SearchWebResult {
  status: "success" | "error";
  query: string;
  answer: string;
  citations: Citation[];
  sources: string[];
  error: string | null;
  remaining_calls: number;
}

export interface SearchRunMetrics {
  outerTokens: number;
  innerTokens: number;
  outerCachedTokens: number;
  innerCachedTokens: number;
  outerCacheWriteTokens: number;
  innerCacheWriteTokens: number;
  ptcRounds: number;
  innerSearchCalls: number;
  responseItemTypes: string[];
  outerModels: string[];
  innerModels: string[];
}

export interface SearchRunResult {
  text: string;
  responseId: string;
  tokens: number;
  metrics: SearchRunMetrics;
}

export interface PtcSearchOptions {
  instructions?: string | undefined;
  previousResponseId?: string | undefined;
  compactedInput?: ResponseInput | undefined;
  reasoningEffort: ReasoningEffort;
  searchContextSize: SearchContextSize;
  outputVerbosity: OutputVerbosity;
  maxSearchCalls?: number;
  maxPtcRounds?: number;
}

export interface ResponsesClientLike {
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
    ): Promise<Response>;
  };
}

const searchParameters = {
  type: "object",
  properties: {
    query: {
      type: "string",
      minLength: 1,
      description: "A focused web-search query.",
    },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

const citationSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    url: { type: "string" },
  },
  required: ["title", "url"],
  additionalProperties: false,
} as const;

const searchOutputSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "error"] },
    query: { type: "string" },
    answer: { type: "string" },
    citations: { type: "array", items: citationSchema },
    sources: { type: "array", items: { type: "string" } },
    error: { type: ["string", "null"] },
    remaining_calls: { type: "number" },
  },
  required: [
    "status",
    "query",
    "answer",
    "citations",
    "sources",
    "error",
    "remaining_calls",
  ],
  additionalProperties: false,
} as const;

export const PTC_TOOLS: Tool[] = [
  {
    type: "function",
    name: SEARCH_FUNCTION_NAME,
    description:
      "Run one focused, read-only web search. Returns answer text, inline citation metadata, the complete consulted URL list, and a structured error when retrieval fails.",
    parameters: searchParameters,
    output_schema: searchOutputSchema,
    allowed_callers: ["programmatic"],
    strict: true,
  },
  { type: "programmatic_tool_calling" },
];

function ptcInstructions(maxSearchCalls: number, remaining: number): string {
  return `<tool_orchestration>
Use Programmatic Tool Calling for the bounded retrieval stage using only search_web.
Run independent searches concurrently when useful. Search at most ${maxSearchCalls} times total.
${remaining} search_web calls remain in this query. If remaining is 0, do not call search_web; reduce findings and return control.
Use only the documented query input and result fields. Do not repeat a completed query.
Deduplicate and reduce the intermediate results before returning control to the model.

The program must emit one compact JSON object with status, findings, citations, sources,
and errors. Preserve enough evidence for the final answer. Stop once the user's question
can be answered with adequate evidence. Do not retry a failed query more than once.

After the program finishes, produce the final user-facing answer yourself. Preserve
clickable Markdown links for web-derived claims. If any required evidence is missing,
state the limitation instead of inventing it.
</tool_orchestration>`;
}

function usageValue(response: Response, key: "total_tokens"): number;
function usageValue(
  response: Response,
  key: "cached_tokens" | "cache_write_tokens",
): number;
function usageValue(
  response: Response,
  key: "total_tokens" | "cached_tokens" | "cache_write_tokens",
): number {
  if (key === "total_tokens") return response.usage?.total_tokens ?? 0;
  return response.usage?.input_tokens_details?.[key] ?? 0;
}

function dedupeCitations(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  return citations.filter(({ url }) => {
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractCitations(response: Response): Citation[] {
  const citations: Citation[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const content of item.content) {
      if (content.type !== "output_text") continue;
      for (const annotation of content.annotations) {
        if (annotation.type === "url_citation") {
          citations.push({ title: annotation.title, url: annotation.url });
        }
      }
    }
  }
  return dedupeCitations(citations);
}

function extractSources(response: Response): string[] {
  const sources: string[] = [];
  for (const item of response.output) {
    if (item.type !== "web_search_call") continue;

    switch (item.action.type) {
      case "search":
        for (const source of item.action.sources ?? []) {
          sources.push(source.url);
        }
        break;
      case "open_page":
        if (item.action.url) sources.push(item.action.url);
        break;
      case "find_in_page":
        sources.push(item.action.url);
        break;
    }
  }
  return dedupeStrings(sources);
}

function errorResult(
  query: string,
  error: unknown,
  remainingCalls = 0,
): SearchWebResult {
  return {
    status: "error",
    query,
    answer: "",
    citations: [],
    sources: [],
    error: error instanceof Error ? error.message : String(error),
    remaining_calls: remainingCalls,
  };
}

function parseSearchArguments(argumentsJson: string): { query: string } {
  const parsed: unknown = JSON.parse(argumentsJson);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("query" in parsed) ||
    typeof parsed.query !== "string" ||
    parsed.query.trim().length === 0
  ) {
    throw new Error("search_web requires a non-empty string query");
  }
  return { query: parsed.query.trim() };
}

async function runInnerSearch(
  client: ResponsesClientLike,
  query: string,
  searchContextSize: SearchContextSize,
): Promise<{ result: SearchWebResult; response: Response }> {
  const response = await client.responses.create({
    model: MODEL,
    input: query,
    instructions:
      "Answer the focused query using web search. Keep the result compact, factual, and citation-rich. Do not perform unrelated work.",
    tools: [
      {
        type: "web_search",
        search_context_size: searchContextSize,
      },
    ],
    tool_choice: "required",
    reasoning: { effort: "none", context: "current_turn" },
    text: { verbosity: "low" },
    include: ["web_search_call.action.sources"],
    store: false,
  });

  if (response.status !== "completed") {
    const detail =
      response.error?.message ?? response.incomplete_details?.reason ?? null;
    const message = `Inner web-search response ended with status ${response.status}${
      detail ? `: ${detail}` : ""
    }`;
    return { response, result: errorResult(query, message) };
  }

  return {
    response,
    result: {
      status: "success",
      query,
      answer: response.output_text || "No response text available.",
      citations: extractCitations(response),
      sources: extractSources(response),
      error: null,
      remaining_calls: 0,
    },
  };
}

function getFinalMessage(response: Response): ResponseOutputMessage | undefined {
  return response.output.find(
    (item): item is ResponseOutputMessage => item.type === "message",
  );
}

function getFunctionCalls(response: Response): ResponseFunctionToolCall[] {
  return response.output.filter(
    (item): item is ResponseFunctionToolCall => item.type === "function_call",
  );
}

function refusalText(message: ResponseOutputMessage): string {
  return (
    message.content.find((content) => content.type === "refusal")?.refusal ?? ""
  );
}

function appendSources(text: string, citations: Citation[]): string {
  const missing = citations.filter(({ url }) => !text.includes(url));
  if (missing.length === 0) return text;
  const links = missing.map(({ title, url }) => `- [${title || url}](${url})`);
  return `${text}\n\n## Sources\n\n${links.join("\n")}`;
}

function tryParseQuery(argumentsJson: string): string {
  try {
    return parseSearchArguments(argumentsJson).query;
  } catch {
    return "";
  }
}

function functionCallOutput(
  call: ResponseFunctionToolCall,
  result: SearchWebResult,
) {
  return {
    type: "function_call_output" as const,
    call_id: call.call_id,
    output: JSON.stringify(result),
    ...(call.caller !== undefined && { caller: call.caller }),
  };
}

function withRemainingCalls(
  result: SearchWebResult,
  remainingCalls: number,
): SearchWebResult {
  return { ...result, remaining_calls: remainingCalls };
}

export async function executePtcSearch(
  client: ResponsesClientLike,
  input: string,
  options: PtcSearchOptions,
): Promise<SearchRunResult> {
  const maxSearchCalls = options.maxSearchCalls ?? DEFAULT_MAX_SEARCH_CALLS;
  const maxPtcRounds = options.maxPtcRounds ?? DEFAULT_MAX_PTC_ROUNDS;
  const metrics: SearchRunMetrics = {
    outerTokens: 0,
    innerTokens: 0,
    outerCachedTokens: 0,
    innerCachedTokens: 0,
    outerCacheWriteTokens: 0,
    innerCacheWriteTokens: 0,
    ptcRounds: 0,
    innerSearchCalls: 0,
    responseItemTypes: [],
    outerModels: [],
    innerModels: [],
  };
  const allCitations: Citation[] = [];
  let previousResponseId = options.compactedInput
    ? undefined
    : options.previousResponseId;
  let nextInput: NonNullable<ResponseCreateParamsNonStreaming["input"]> =
    options.compactedInput
      ? [...options.compactedInput, { role: "user", content: input }]
      : input;

  for (let round = 1; round <= maxPtcRounds; round++) {
    const remainingAtStart = maxSearchCalls - metrics.innerSearchCalls;
    const request: ResponseCreateParamsNonStreaming = {
      model: MODEL,
      input: nextInput,
      instructions: [
        options.instructions,
        ptcInstructions(maxSearchCalls, remainingAtStart),
      ]
        .filter(Boolean)
        .join("\n\n"),
      tools: PTC_TOOLS,
      tool_choice:
        remainingAtStart === 0
          ? "none"
          : round === 1
            ? { type: "programmatic_tool_calling" }
            : "auto",
      parallel_tool_calls: true,
      reasoning: {
        effort: options.reasoningEffort,
        context: "current_turn",
      },
      text: { verbosity: options.outputVerbosity },
      store: true,
    };
    if (previousResponseId) request.previous_response_id = previousResponseId;

    const response = await client.responses.create(request);
    metrics.ptcRounds = round;
    metrics.outerTokens += usageValue(response, "total_tokens");
    metrics.outerCachedTokens += usageValue(response, "cached_tokens");
    metrics.outerCacheWriteTokens += usageValue(response, "cache_write_tokens");
    metrics.responseItemTypes.push(...response.output.map((item) => item.type));
    metrics.outerModels.push(response.model);

    if (response.status !== "completed") {
      throw new Error(`PTC response ended with status ${response.status}`);
    }

    previousResponseId = response.id;
    const calls = getFunctionCalls(response);
    if (calls.length > 0) {
      const remaining = maxSearchCalls - metrics.innerSearchCalls;
      const outputs = await Promise.all(
        calls.map(async (call, index) => {
          const remainingAfterSlot = Math.max(0, remaining - index - 1);

          if (index >= remaining) {
            return functionCallOutput(
              call,
              errorResult(
                tryParseQuery(call.arguments),
                `Programmatic search budget exceeded: 0 remaining of ${maxSearchCalls}`,
                0,
              ),
            );
          }

          if (call.name !== SEARCH_FUNCTION_NAME) {
            return functionCallOutput(
              call,
              errorResult(
                "",
                `Unknown PTC function: ${call.name}`,
                remaining,
              ),
            );
          }

          let query = "";
          try {
            ({ query } = parseSearchArguments(call.arguments));
            metrics.innerSearchCalls++;
            const inner = await runInnerSearch(
              client,
              query,
              options.searchContextSize,
            );
            metrics.innerTokens += usageValue(inner.response, "total_tokens");
            metrics.innerModels.push(inner.response.model);
            metrics.innerCachedTokens += usageValue(
              inner.response,
              "cached_tokens",
            );
            metrics.innerCacheWriteTokens += usageValue(
              inner.response,
              "cache_write_tokens",
            );
            allCitations.push(...inner.result.citations);
            return functionCallOutput(
              call,
              withRemainingCalls(inner.result, remainingAfterSlot),
            );
          } catch (error) {
            return functionCallOutput(
              call,
              errorResult(query, error, remainingAfterSlot),
            );
          }
        }),
      );

      nextInput = outputs;
      continue;
    }

    const message = getFinalMessage(response);
    if (message) {
      const text = response.output_text || refusalText(message);
      return {
        text: appendSources(text || "No response text available.", dedupeCitations(allCitations)),
        responseId: response.id,
        tokens: metrics.outerTokens,
        metrics,
      };
    }

    nextInput = [];
  }

  throw new Error(`Programmatic search exceeded ${maxPtcRounds} response rounds`);
}

export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= values.length) return;
        results[index] = await mapper(values[index] as T, index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export type OpenAIClient = OpenAI;
export type PtcOutputItem = ResponseOutputItem;
export type PtcOutputText = ResponseOutputText;
export type WebSearchOutput = ResponseFunctionWebSearch;
