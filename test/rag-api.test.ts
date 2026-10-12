import assert from "node:assert/strict";
import test from "node:test";
import { GateError } from "@/lib/gateway/errors";
import { endpointAllowed, endpointOf } from "@/lib/gateway/key-restrictions";
import { searchRequest } from "@/lib/rag/api";
import {
  addChatUsage,
  assistantMessage,
  fileSearchStores,
  searchQueries,
  searchResultText,
  takeFileSearchTool,
  withFileSearch,
  withoutFileSearchHistory,
} from "@/lib/rag/file-search-tool";
import { rerankResults, rerankUsage } from "@/lib/rag/models";
import {
  createVectorStoreSchema,
  fileBatchSchema,
  rerankRequestSchema,
  searchVectorStoreSchema,
} from "@/schemas/rag";
import type { JsonMap, Principal, VirtualKeyView } from "@/types/gateway";

test("vector store schemas enforce OpenAI limits", () => {
  assert.equal(createVectorStoreSchema.safeParse({ name: "kb", embedding_model: "Text-Embed" }).data?.embedding_model, "text-embed");
  assert.equal(
    createVectorStoreSchema.safeParse({
      chunking_strategy: { type: "static", static: { max_chunk_size_tokens: 400, chunk_overlap_tokens: 300 } },
    }).success,
    false,
  );
  assert.equal(createVectorStoreSchema.safeParse({ metadata: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) }).success, false);
  assert.equal(fileBatchSchema.safeParse({}).success, false);
  assert.equal(fileBatchSchema.safeParse({ file_ids: ["a"], files: [{ file_id: "b" }] }).success, false);
  assert.equal(fileBatchSchema.safeParse({ files: [{ file_id: "b", attributes: { year: 2026 } }] }).success, true);
  assert.equal(searchVectorStoreSchema.safeParse({ query: "" }).success, false);
  assert.equal(searchVectorStoreSchema.safeParse({ query: ["a", "b"], max_num_results: 51 }).success, false);
  assert.equal(
    searchVectorStoreSchema.safeParse({
      query: "q",
      filters: { type: "and", filters: [{ type: "eq", key: "a", value: 1 }, { type: "or", filters: [{ type: "in", key: "b", value: ["x"] }] }] },
    }).success,
    true,
  );
  assert.equal(rerankRequestSchema.safeParse({ model: "r", query: "q", documents: [] }).success, false);
});

test("searchRequest maps OpenAI search options and the rerank override", () => {
  const parsed = searchVectorStoreSchema.parse({ query: "q", max_num_results: 3, ranking_options: { ranker: "none" } });
  assert.deepEqual(searchRequest(parsed), {
    queries: ["q"],
    filters: null,
    maxResults: 3,
    ranking: { ranker: "none", scoreThreshold: 0, embeddingWeight: 0.7, textWeight: 0.3 },
    rerankModel: null,
  });
  assert.equal(searchRequest(searchVectorStoreSchema.parse({ query: "q", rerank_model: null })).rerankModel, "");
  assert.equal(searchRequest(searchVectorStoreSchema.parse({ query: "q", rerank_model: "Cohere-Rerank" })).rerankModel, "cohere-rerank");
  assert.throws(
    () => searchRequest(searchVectorStoreSchema.parse({ query: "q", rewrite_query: true })),
    (err: unknown) => err instanceof GateError && err.code === "unsupported_parameter",
  );
});

test("rerank responses from Cohere, Jina, vLLM, and TEI are understood", () => {
  assert.deepEqual(rerankResults({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] }), [
    { index: 1, score: 0.9 },
    { index: 0, score: 0.1 },
  ]);
  assert.deepEqual(rerankResults([{ index: 0, score: 2.5 }]), [{ index: 0, score: 2.5 }]);
  assert.deepEqual(rerankResults({ data: [{ index: "x" }] }), []);
  assert.deepEqual(rerankUsage({ usage: { total_tokens: 120 } }), { prompt_tokens: 120, completion_tokens: 0, total_tokens: 120 });
  assert.deepEqual(rerankUsage({ meta: { billed_units: { input_tokens: 7 } } }).prompt_tokens, 7);
  assert.equal(rerankUsage({ usage: { prompt_tokens: 5, cost: 0.002 } }).cost, 0.002);
});

test("takeFileSearchTool strips the hosted tool and validates it", () => {
  const body: JsonMap = {
    model: "m",
    tools: [
      { type: "function", name: "lookup" },
      { type: "file_search", vector_store_ids: ["vs_1", "vs_1"], max_num_results: 4 },
    ],
    tool_choice: { type: "file_search" },
  };
  const taken = takeFileSearchTool(body);
  assert.deepEqual(taken.body.tools, [{ type: "function", name: "lookup" }]);
  assert.equal(taken.body.tool_choice, "required");
  assert.deepEqual(taken.tool?.vectorStoreIds, ["vs_1"]);
  assert.equal(taken.tool?.maxResults, 4);
  assert.equal(takeFileSearchTool({ model: "m" }).tool, null);
  const invalid = (tools: unknown[]) =>
    assert.throws(() => takeFileSearchTool({ tools }), (err: unknown) => err instanceof GateError && err.status === 400);
  invalid([{ type: "file_search" }]);
  invalid([{ type: "file_search", vector_store_ids: ["a"] }, { type: "file_search", vector_store_ids: ["b"] }]);
  invalid([{ type: "file_search", vector_store_ids: ["a"] }, { type: "function", name: "file_search" }]);
});

test("withFileSearch adds the search function and maps tool_choice", () => {
  const chat = withFileSearch({ model: "m", messages: [] }, { type: "file_search" }, false);
  const tools = chat.tools as JsonMap[];
  assert.equal((tools[0]!.function as JsonMap).name, "file_search");
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "file_search" } });
  assert.equal(chat.parallel_tool_calls, false);
  assert.equal(withFileSearch({ tools: [] }, "none", undefined).tool_choice, "none");
  assert.equal(withFileSearch({ tools: [] }, "auto", undefined).tool_choice, undefined);
});

test("history without a file_search tool drops earlier search rounds", () => {
  const history: JsonMap[] = [
    { role: "user", content: "q" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "file_search", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c1", content: "results" },
    {
      role: "assistant",
      content: "partial",
      tool_calls: [
        { id: "c2", type: "function", function: { name: "file_search", arguments: "{}" } },
        { id: "c3", type: "function", function: { name: "lookup", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "c2", content: "more" },
    { role: "tool", tool_call_id: "c3", content: "lookup result" },
    { role: "assistant", content: "answer" },
  ];
  assert.deepEqual(withoutFileSearchHistory(history), [
    { role: "user", content: "q" },
    { role: "assistant", content: "partial", tool_calls: [{ id: "c3", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c3", content: "lookup result" },
    { role: "assistant", content: "answer" },
  ]);
});

test("search arguments, results, usage, and assistant turns are normalized", () => {
  assert.deepEqual(searchQueries('{"queries":["a"," b ",3,""]}'), ["a", "b"]);
  assert.deepEqual(searchQueries('{"query":"single"}'), ["single"]);
  assert.deepEqual(searchQueries("not json"), ["not json"]);
  assert.equal(searchResultText([]), "No matching content was found in the attached files.");
  const text = searchResultText([
    { storeId: "vs", fileId: "f1", filename: 'a"b.txt', chunkId: "c", position: 0, score: 0.5, attributes: {}, text: "body" },
  ]);
  assert.equal(text, '<result index="1" file_id="f1" filename="a&quot;b.txt" score="0.500">\nbody\n</result>');
  assert.deepEqual(addChatUsage({ prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }, { prompt_tokens: 4, total_tokens: 4 }), {
    prompt_tokens: 5,
    completion_tokens: 2,
    total_tokens: 7,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  });
  assert.equal(addChatUsage(null, null), null);
  const turn = assistantMessage({
    content: [{ type: "text", text: "hi" }],
    thinking_blocks: [{ type: "thinking", thinking: "t", signature: "s" }],
    tool_calls: [{ id: "", function: { name: "file_search", arguments: { queries: ["x"] } } }],
  });
  assert.equal(turn.content, "hi");
  assert.deepEqual(turn.thinking_blocks, [{ type: "thinking", thinking: "t", signature: "s" }]);
  const [call] = turn.tool_calls as JsonMap[];
  assert.match(String(call!.id), /^call_/);
  assert.deepEqual(call!.function, { name: "file_search", arguments: '{"queries":["x"]}' });
});

test("vector stores and rerank are their own key endpoint groups", async () => {
  assert.equal(endpointOf("/v1/vector_stores"), "vector_stores");
  assert.equal(endpointOf("/v1/vector_stores/vs_1/files/f1/content"), "vector_stores");
  assert.equal(endpointOf("/v1/rerank"), "rerank");
  assert.equal(endpointAllowed(["files"], "/v1/vector_stores/vs_1/search"), false);
  assert.equal(endpointAllowed(["embeddings"], "/v1/rerank"), false);
  assert.equal(endpointAllowed(["vector_stores", "rerank"], "/v1/vector_stores/vs_1/search"), true);
  const chatOnly: Principal = {
    actor: "sk",
    key: { token_id: "k", project_id: "p", member_id: "", allowed_endpoints: ["chat"] } as unknown as VirtualKeyView,
    teamId: "",
    orgId: "acme",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
  };
  const tool = takeFileSearchTool({ tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] }).tool!;
  await assert.rejects(
    fileSearchStores(chatOnly, tool),
    (err: unknown) => err instanceof GateError && err.code === "endpoint_not_allowed" && err.param === "tools",
  );
});
