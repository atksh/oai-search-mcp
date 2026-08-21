import assert from "node:assert/strict";
import test from "node:test";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
} from "openai/resources/responses/responses";
import {
  executePtcSearch,
  mapWithConcurrency,
  MODEL,
  PTC_TOOLS,
  type ResponsesClientLike,
} from "./ptc-search.js";

function usage(total = 10): NonNullable<Response["usage"]> {
  return {
    input_tokens: Math.floor(total / 2),
    input_tokens_details: {
      cached_tokens: 2,
      cache_write_tokens: 1,
    },
    output_tokens: Math.ceil(total / 2),
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: total,
  };
}

function response(
  id: string,
  output: Response["output"],
  totalTokens = 10,
): Response {
  const outputText = output
    .flatMap((item) =>
      item.type === "message" ? item.content : [],
    )
    .filter((content) => content.type === "output_text")
    .map((content) => content.text)
    .join("");

  return {
    id,
    created_at: 0,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
    model: MODEL,
    object: "response",
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    temperature: null,
    tool_choice: "auto",
    tools: PTC_TOOLS,
    top_p: null,
    background: false,
    conversation: null,
    max_output_tokens: null,
    max_tool_calls: null,
    previous_response_id: null,
    prompt: null,
    prompt_cache_key: null,
    prompt_cache_options: null,
    reasoning: { effort: "medium", context: "current_turn" },
    safety_identifier: null,
    service_tier: "default",
    status: "completed",
    text: { format: { type: "text" }, verbosity: "medium" },
    top_logprobs: 0,
    truncation: "disabled",
    usage: usage(totalTokens),
    user: null,
    prompt_cache_retention: null,
  };
}

class FakeClient implements ResponsesClientLike {
  readonly requests: ResponseCreateParamsNonStreaming[] = [];

  constructor(private readonly queue: Array<Response | Error>) {}

  responses = {
    create: async (body: ResponseCreateParamsNonStreaming): Promise<Response> => {
      this.requests.push(body);
      const next = this.queue.shift();
      if (!next) throw new Error("Unexpected Responses call");
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function programCall(callId: string, query: string) {
  return {
    type: "function_call" as const,
    id: `fc_${callId}`,
    call_id: callId,
    name: "search_web",
    arguments: JSON.stringify({ query }),
    caller: { type: "program" as const, caller_id: "prog_1" },
    status: "completed" as const,
  };
}

function finalMessage(text: string) {
  return {
    type: "message" as const,
    id: "msg_1",
    role: "assistant" as const,
    status: "completed" as const,
    content: [
      {
        type: "output_text" as const,
        text,
        annotations: [],
      },
    ],
  };
}

function innerSearchResponse(
  id: string,
  query: string,
  url = "https://developers.openai.com/example",
  totalTokens = 7,
) {
  return response(
    id,
    [
      {
        type: "web_search_call",
        id: `ws_${id}`,
        status: "completed",
        action: {
          type: "search",
          queries: [query],
          sources: [{ type: "url", url }],
        },
      },
      {
        type: "message",
        id: `msg_${id}`,
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: `Inner answer for ${query}`,
            annotations: [
              {
                type: "url_citation",
                title: "OpenAI example",
                url,
                start_index: 0,
                end_index: 5,
              },
            ],
          },
        ],
      },
    ],
    totalTokens,
  );
}

function parsedOutput(requestInput: unknown, index = 0) {
  assert.ok(Array.isArray(requestInput));
  const output = Array.isArray(requestInput) ? requestInput[index] : undefined;
  assert.equal(output?.type, "function_call_output");
  if (output?.type !== "function_call_output") {
    throw new Error("Expected a function_call_output");
  }
  return JSON.parse(String(output.output)) as {
    status: string;
    query: string;
    error: string | null;
    remaining_calls: number;
    sources?: string[];
  };
}

test("declares a strict program-only search function and PTC hosted tool", () => {
  const searchTool = PTC_TOOLS[0];
  assert.equal(searchTool?.type, "function");
  if (searchTool?.type !== "function") return;
  assert.deepEqual(searchTool.allowed_callers, ["programmatic"]);
  assert.equal(searchTool.strict, true);
  assert.ok(searchTool.output_schema);
  assert.deepEqual(PTC_TOOLS[1], { type: "programmatic_tool_calling" });
});

test("runs PTC, preserves caller linkage, extracts sources, and completes", async () => {
  const client = new FakeClient([
    response("outer_1", [programCall("call_1", "GPT-5.6 release")], 11),
    response(
      "inner_1",
      [
        {
          type: "web_search_call",
          id: "ws_1",
          status: "completed",
          action: {
            type: "search",
            queries: ["GPT-5.6 release"],
            sources: [
              { type: "url", url: "https://developers.openai.com/example" },
            ],
          },
        },
        {
          type: "web_search_call",
          id: "ws_open",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://developers.openai.com/opened",
          },
        },
        {
          type: "web_search_call",
          id: "ws_find",
          status: "completed",
          action: {
            type: "find_in_page",
            pattern: "Programmatic Tool Calling",
            url: "https://developers.openai.com/searched",
          },
        },
        {
          type: "message",
          id: "msg_inner",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text: "Inner answer",
              annotations: [
                {
                  type: "url_citation",
                  title: "OpenAI example",
                  url: "https://developers.openai.com/example",
                  start_index: 0,
                  end_index: 5,
                },
              ],
            },
          ],
        },
      ],
      7,
    ),
    response("outer_2", [finalMessage("Final answer")], 13),
  ]);

  const result = await executePtcSearch(client, "Research GPT-5.6", {
    reasoningEffort: "medium",
    searchContextSize: "high",
    outputVerbosity: "low",
  });

  assert.equal(result.responseId, "outer_2");
  assert.match(result.text, /\[OpenAI example\]\(https:\/\/developers\.openai\.com\/example\)/);
  assert.equal(result.tokens, 24);
  assert.equal(result.metrics.innerTokens, 7);
  assert.equal(result.metrics.innerSearchCalls, 1);
  assert.deepEqual(result.metrics.outerModels, [MODEL, MODEL]);
  assert.deepEqual(result.metrics.innerModels, [MODEL]);

  assert.deepEqual(client.requests[0]?.tool_choice, {
    type: "programmatic_tool_calling",
  });
  assert.match(String(client.requests[0]?.instructions), /Search at most 5 times total/);
  assert.match(String(client.requests[0]?.instructions), /5 search_web calls remain/);
  assert.equal(client.requests[0]?.reasoning?.context, "current_turn");
  assert.equal(client.requests[1]?.reasoning?.effort, "none");
  assert.equal(client.requests[1]?.tools?.[0]?.type, "web_search");
  assert.deepEqual(client.requests[1]?.include, [
    "web_search_call.action.sources",
  ]);
  assert.equal(client.requests[2]?.previous_response_id, "outer_1");
  const continuation = client.requests[2]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    assert.equal(output?.type, "function_call_output");
    if (output?.type === "function_call_output") {
      assert.equal(output.call_id, "call_1");
      assert.deepEqual(output.caller, {
        type: "program",
        caller_id: "prog_1",
      });
      const parsed = JSON.parse(String(output.output)) as {
        sources: string[];
        remaining_calls: number;
      };
      assert.equal(parsed.remaining_calls, 4);
      assert.deepEqual(parsed.sources, [
        "https://developers.openai.com/example",
        "https://developers.openai.com/opened",
        "https://developers.openai.com/searched",
      ]);
    }
  }
});

test("replays standalone compaction output before the next user message", async () => {
  const compactedInput: ResponseInput = [
    { role: "user", content: "Earlier question" },
    {
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "opaque-compaction-state",
    },
  ];
  const client = new FakeClient([
    response("outer_after_compaction", [finalMessage("GPT-5.6")]),
  ]);

  await executePtcSearch(client, "What model family were we discussing?", {
    previousResponseId: "must_not_be_used_with_compacted_input",
    compactedInput,
    reasoningEffort: "low",
    searchContextSize: "low",
    outputVerbosity: "low",
  });

  const request = client.requests[0];
  assert.equal(request?.previous_response_id, undefined);
  assert.ok(Array.isArray(request?.input));
  if (Array.isArray(request?.input)) {
    assert.deepEqual(request.input.slice(0, 2), compactedInput);
    assert.deepEqual(request.input[2], {
      role: "user",
      content: "What model family were we discussing?",
    });
  }
});

test("continues after a later round requests one search with 0 remaining", async () => {
  const client = new FakeClient([
    response("outer_1", [programCall("call_1", "one")]),
    innerSearchResponse("inner_1", "one"),
    response("outer_2", [programCall("call_2", "two")]),
    response("outer_3", [finalMessage("Answer with gathered evidence")]),
  ]);

  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
    maxSearchCalls: 1,
  });

  assert.equal(result.responseId, "outer_3");
  assert.match(result.text, /Answer with gathered evidence/);
  assert.equal(result.metrics.innerSearchCalls, 1);
  assert.equal(result.metrics.ptcRounds, 3);
  assert.equal(client.requests.length, 4);
  assert.equal(client.requests[1]?.input, "one");
  assert.equal(client.requests[2]?.tool_choice, "none");
  assert.match(String(client.requests[2]?.instructions), /0 search_web calls remain/);
  assert.equal(client.requests[3]?.tool_choice, "none");

  const rejected = parsedOutput(client.requests[3]?.input);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.query, "two");
  assert.equal(rejected.remaining_calls, 0);
  assert.match(rejected.error ?? "", /0 remaining of 1/);
});

test("fulfills remaining slots and errors excess calls in the same batch", async () => {
  const client = new FakeClient([
    response("outer_1", [
      programCall("call_1", "one"),
      programCall("call_2", "two"),
    ]),
    innerSearchResponse("inner_1", "one"),
    response("outer_2", [finalMessage("Partial evidence synthesized")]),
  ]);

  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
    maxSearchCalls: 1,
  });

  assert.equal(result.responseId, "outer_2");
  assert.match(result.text, /Partial evidence synthesized/);
  assert.equal(result.metrics.innerSearchCalls, 1);
  assert.equal(client.requests.length, 3);
  assert.equal(client.requests[1]?.input, "one");
  assert.equal(client.requests[2]?.tool_choice, "none");

  const fulfilled = parsedOutput(client.requests[2]?.input, 0);
  assert.equal(fulfilled.status, "success");
  assert.equal(fulfilled.query, "one");
  assert.equal(fulfilled.remaining_calls, 0);

  const rejected = parsedOutput(client.requests[2]?.input, 1);
  assert.equal(rejected.status, "error");
  assert.equal(rejected.query, "two");
  assert.equal(rejected.remaining_calls, 0);
  assert.match(rejected.error ?? "", /0 remaining of 1/);
});

test("returns a structured error for malformed program arguments", async () => {
  const malformed = programCall("call_bad", "placeholder");
  malformed.arguments = "not-json";
  const client = new FakeClient([
    response("outer_1", [malformed]),
    response("outer_2", [finalMessage("Unable to search")]),
  ]);

  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
  });

  assert.equal(result.metrics.innerSearchCalls, 0);
  const continuation = client.requests[1]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    assert.equal(output?.type, "function_call_output");
    if (output?.type === "function_call_output") {
      const parsed = JSON.parse(String(output.output)) as {
        status: string;
        error: string;
      };
      assert.equal(parsed.status, "error");
      assert.match(parsed.error, /JSON/);
    }
  }
});

test("returns a structured error for an unknown function without executing it", async () => {
  const unknown = programCall("call_unknown", "placeholder");
  unknown.name = "unexpected_tool";
  const client = new FakeClient([
    response("outer_1", [unknown]),
    response("outer_2", [finalMessage("Unknown tool handled")]),
  ]);

  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
  });

  assert.equal(result.metrics.innerSearchCalls, 0);
  assert.equal(client.requests.length, 2);
  const continuation = client.requests[1]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    if (output?.type === "function_call_output") {
      assert.match(String(output.output), /Unknown PTC function/);
    } else {
      assert.fail("Expected a function_call_output");
    }
  }
});

test("returns a structured error when an inner web-search request fails", async () => {
  const client = new FakeClient([
    response("outer_1", [programCall("call_1", "query")]),
    new Error("inner search unavailable"),
    response("outer_2", [finalMessage("Search failed cleanly")]),
  ]);
  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
  });

  assert.equal(result.metrics.innerSearchCalls, 1);
  const continuation = client.requests[2]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    if (output?.type === "function_call_output") {
      assert.match(String(output.output), /inner search unavailable/);
    } else {
      assert.fail("Expected a function_call_output");
    }
  }
});

test("returns a structured error for a non-completed inner response", async () => {
  const incomplete = response("inner_incomplete", [], 7);
  incomplete.status = "incomplete";
  incomplete.incomplete_details = { reason: "max_output_tokens" };
  const client = new FakeClient([
    response("outer_1", [programCall("call_1", "query")]),
    incomplete,
    response("outer_2", [finalMessage("Search incomplete")]),
  ]);

  const result = await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
  });

  assert.equal(result.metrics.innerSearchCalls, 1);
  assert.equal(result.metrics.innerTokens, 7);
  const continuation = client.requests[2]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    if (output?.type === "function_call_output") {
      const parsed = JSON.parse(String(output.output)) as {
        status: string;
        error: string;
      };
      assert.equal(parsed.status, "error");
      assert.match(parsed.error, /status incomplete: max_output_tokens/);
    } else {
      assert.fail("Expected a function_call_output");
    }
  }
});

test("preserves the API error from a failed inner response", async () => {
  const failed = response("inner_failed", [], 3);
  failed.status = "failed";
  failed.error = {
    code: "server_error",
    message: "upstream search unavailable",
  };
  const client = new FakeClient([
    response("outer_1", [programCall("call_1", "query")]),
    failed,
    response("outer_2", [finalMessage("Search failed")]),
  ]);

  await executePtcSearch(client, "query", {
    reasoningEffort: "medium",
    searchContextSize: "medium",
    outputVerbosity: "medium",
  });

  const continuation = client.requests[2]?.input;
  assert.ok(Array.isArray(continuation));
  if (Array.isArray(continuation)) {
    const output = continuation[0];
    if (output?.type === "function_call_output") {
      const parsed = JSON.parse(String(output.output)) as {
        status: string;
        error: string;
      };
      assert.equal(parsed.status, "error");
      assert.match(parsed.error, /status failed: upstream search unavailable/);
    } else {
      assert.fail("Expected a function_call_output");
    }
  }
});

test("fails closed after the configured response-round limit", async () => {
  const client = new FakeClient([
    response("outer_1", [{
      type: "program",
      id: "prog_1",
      call_id: "prog_call_1",
      code: "text('pending')",
      fingerprint: "opaque",
    }]),
    response("outer_2", [{
      type: "program_output",
      id: "prog_out_1",
      call_id: "prog_call_1",
      result: "pending",
      status: "incomplete",
    }]),
  ]);

  await assert.rejects(
    executePtcSearch(client, "query", {
      reasoningEffort: "medium",
      searchContextSize: "medium",
      outputVerbosity: "medium",
      maxPtcRounds: 2,
    }),
    /exceeded 2 response rounds/,
  );
});

test("mapWithConcurrency bounds active work and preserves order", async () => {
  let active = 0;
  let peak = 0;
  const results = await mapWithConcurrency([0, 1, 2, 3, 4, 5], 3, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 5 + (5 - value)));
    active--;
    return value * 2;
  });

  assert.equal(peak, 3);
  assert.deepEqual(results, [0, 2, 4, 6, 8, 10]);
});
