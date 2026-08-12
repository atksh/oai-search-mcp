import OpenAI from "openai";
import { executePtcSearch, MODEL } from "../ptc-search.js";

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY is required for the live PTC smoke test.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  maxRetries: 1,
  timeout: 300_000,
});

const result = await executePtcSearch(
  client,
  "Find two official OpenAI documentation pages about GPT-5.6 and summarize one supported feature from each. Include clickable links.",
  {
    reasoningEffort: "low",
    searchContextSize: "low",
    outputVerbosity: "low",
  },
);

const followUp = await executePtcSearch(
  client,
  "Which of those two pages is specifically the Programmatic Tool Calling guide? Answer with its clickable link.",
  {
    previousResponseId: result.responseId,
    reasoningEffort: "low",
    searchContextSize: "low",
    outputVerbosity: "low",
  },
);

const compacted = await client.responses.compact({
  model: MODEL,
  previous_response_id: followUp.responseId,
});
const compactFollowUp = await executePtcSearch(
  client,
  "Using the compacted conversation, name the model family under discussion in one sentence.",
  {
    compactedInput: compacted.output,
    reasoningEffort: "low",
    searchContextSize: "low",
    outputVerbosity: "low",
  },
);

const requiredTypes = ["program", "function_call", "program_output", "message"];
const missingTypes = requiredTypes.filter(
  (type) => !result.metrics.responseItemTypes.includes(type),
);
const wrongModels = [
  ...result.metrics.outerModels,
  ...result.metrics.innerModels,
].filter((model) => model !== MODEL);
const hasLink = /https:\/\//.test(result.text);
const followUpHasLink = /https:\/\//.test(followUp.text);
const compactionWorked = compactFollowUp.responseId.length > 0;

const summary = {
  status:
    missingTypes.length === 0 &&
    wrongModels.length === 0 &&
    hasLink &&
    followUpHasLink &&
    compactionWorked
      ? "passed"
      : "failed",
  responseId: result.responseId,
  model: MODEL,
  ptcRounds: result.metrics.ptcRounds,
  innerSearchCalls: result.metrics.innerSearchCalls,
  responseItemTypes: result.metrics.responseItemTypes,
  outerTokens: result.metrics.outerTokens,
  innerTokens: result.metrics.innerTokens,
  missingTypes,
  wrongModels,
  hasLink,
  followUpHasLink,
  compactionWorked,
};

console.log(JSON.stringify(summary, null, 2));
if (summary.status !== "passed") process.exitCode = 1;
