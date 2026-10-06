import assert from "node:assert/strict";
import test from "node:test";
import {
  addBatchUsage,
  batchErrors,
  batchObject,
  emptyBatchUsage,
  expiredLine,
  isBatchEndpoint,
  jsonl,
  parseBatchInput,
  resultLine,
} from "@/lib/gateway/batch-format";
import type { JsonMap } from "@/types/gateway";

function line(custom: string, body: JsonMap, url = "/v1/chat/completions"): string {
  return JSON.stringify({ custom_id: custom, method: "POST", url, body });
}

test("batch input parses valid lines and enforces OpenAI batch rules", () => {
  const ok = parseBatchInput(
    [line("a", { model: "m", messages: [] }), "", line("b", { model: "m", messages: [] })].join("\n"),
    "/v1/chat/completions",
  );
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.model, "m");
  assert.deepEqual(
    ok.lines.map((row) => [row.line, row.customId]),
    [
      [1, "a"],
      [3, "b"],
    ],
  );
  const bad = parseBatchInput(
    [
      "not json",
      JSON.stringify({ url: "/v1/chat/completions", body: { model: "m" } }),
      line("a", { model: "m" }),
      line("a", { model: "m" }),
      line("c", { model: "m" }, "/v1/embeddings"),
      JSON.stringify({ custom_id: "d", method: "GET", url: "/v1/chat/completions", body: { model: "m" } }),
      line("e", { messages: [] }),
      line("f", { model: "other" }),
      line("g", { model: "m", stream: true }),
    ].join("\n"),
    "/v1/chat/completions",
  );
  assert.deepEqual(
    bad.errors.map((error) => [error.line, error.code]),
    [
      [1, "invalid_json"],
      [2, "missing_custom_id"],
      [4, "duplicate_custom_id"],
      [5, "mismatched_endpoint"],
      [6, "invalid_method"],
      [7, "missing_model"],
      [8, "mismatched_model"],
      [9, "invalid_request"],
    ],
  );
  assert.equal(parseBatchInput("\n\n", "/v1/embeddings").errors[0]?.code, "empty_file");
});

test("batch endpoints cover the OpenAI batch surface the gateway serves", () => {
  for (const endpoint of [
    "/v1/chat/completions",
    "/v1/responses",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/moderations",
    "/v1/images/generations",
  ]) {
    assert.equal(isBatchEndpoint(endpoint), true, endpoint);
  }
  assert.equal(isBatchEndpoint("/v1/messages"), false);
  assert.equal(isBatchEndpoint(42), false);
});

test("batch objects and result lines follow the OpenAI shapes", () => {
  const batch = batchObject({
    id: "b1",
    endpoint: "/v1/embeddings",
    model: "m",
    inputFileId: "f1",
    createdAt: 1000,
    total: 2,
    metadata: { team: "x" },
  });
  assert.equal(batch.object, "batch");
  assert.equal(batch.status, "validating");
  assert.equal(batch.completion_window, "24h");
  assert.equal(batch.expires_at, 1000 + 86_400);
  assert.deepEqual(batch.request_counts, { total: 2, completed: 0, failed: 0 });
  const ok = resultLine("a", { ok: true, body: { id: "x" }, usage: null });
  assert.match(String(ok.id), /^batch_req_/);
  assert.equal(ok.custom_id, "a");
  assert.equal(ok.error, null);
  assert.equal((ok.response as JsonMap).status_code, 200);
  assert.match(String((ok.response as JsonMap).request_id), /^req_/);
  assert.deepEqual((ok.response as JsonMap).body, { id: "x" });
  const failed = resultLine("b", { ok: false, status: 404, error: { message: "no", type: "invalid_request_error", code: "model_not_found" } });
  assert.deepEqual((failed.response as JsonMap).body, {
    error: { message: "no", type: "invalid_request_error", code: "model_not_found" },
  });
  assert.equal((failed.response as JsonMap).status_code, 404);
  const expired = expiredLine("c", "batch_expired", "late");
  assert.equal(expired.response, null);
  assert.deepEqual(expired.error, { code: "batch_expired", message: "late" });
  assert.deepEqual(batchErrors([{ code: "x", message: "y", line: 0, param: null }]), {
    object: "list",
    data: [{ code: "x", message: "y", line: null, param: null }],
  });
  assert.equal(jsonl([{ a: 1 }, { b: 2 }]).toString(), '{"a":1}\n{"b":2}\n');
  assert.equal(jsonl([]).toString(), "");
});

test("batch usage sums chat and Responses usage with cache and reasoning details", () => {
  let usage = emptyBatchUsage();
  usage = addBatchUsage(usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    prompt_tokens_details: { cached_tokens: 4 },
    completion_tokens_details: { reasoning_tokens: 2 },
  });
  usage = addBatchUsage(usage, { input_tokens: 7, output_tokens: 3, output_tokens_details: { reasoning_tokens: 1 } });
  usage = addBatchUsage(usage, null);
  assert.deepEqual(usage, {
    input_tokens: 17,
    input_tokens_details: { cached_tokens: 4 },
    output_tokens: 8,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 25,
  });
});
