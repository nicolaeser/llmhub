import { asRecord, newId } from "@/lib/gateway/core";
import { modelAlias } from "@/lib/gateway/model-alias";
import type { BatchEndpoint, BatchLine, BatchLineError, BatchLineResult } from "@/types/batches";
import type { JsonMap } from "@/types/gateway";

export const BATCH_ENDPOINTS: Record<BatchEndpoint, string> = {
  "/v1/chat/completions": "/chat/completions",
  "/v1/responses": "/responses",
  "/v1/completions": "/completions",
  "/v1/embeddings": "/embeddings",
  "/v1/moderations": "/moderations",
  "/v1/images/generations": "/images/generations",
};

export const MAX_BATCH_REQUESTS = 50_000;
export const BATCH_QUEUED = "queued";
export const BATCH_DONE = "done";
export const BATCH_RUNNING = "running:";
export const BATCH_RESULT_PURPOSE = "batch_output";
export const BATCH_WINDOW = "24h";
export const BATCH_WINDOW_SECONDS = 24 * 60 * 60;
export const BATCH_TERMINAL = new Set(["failed", "completed", "expired", "cancelled"]);

export function isBatchEndpoint(value: unknown): value is BatchEndpoint {
  return typeof value === "string" && value in BATCH_ENDPOINTS;
}

function lineError(line: number, code: string, message: string, param: string | null = null): BatchLineError {
  return { code, message, line, param };
}

export function parseBatchInput(
  text: string,
  endpoint: BatchEndpoint,
): { lines: BatchLine[]; errors: BatchLineError[]; model: string } {
  const lines: BatchLine[] = [];
  const errors: BatchLineError[] = [];
  const seen = new Set<string>();
  let model = "";
  text.split("\n").forEach((raw, index) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const line = index + 1;
    let rec: JsonMap | null = null;
    try {
      rec = asRecord(JSON.parse(trimmed));
    } catch {}
    if (!rec) {
      errors.push(lineError(line, "invalid_json", "line is not a JSON object"));
      return;
    }
    const customId = typeof rec.custom_id === "string" ? rec.custom_id : "";
    if (!customId) {
      errors.push(lineError(line, "missing_custom_id", "custom_id is required", "custom_id"));
      return;
    }
    if (seen.has(customId)) {
      errors.push(lineError(line, "duplicate_custom_id", `custom_id '${customId}' is not unique`, "custom_id"));
      return;
    }
    seen.add(customId);
    if (rec.method !== undefined && rec.method !== "POST") {
      errors.push(lineError(line, "invalid_method", "method must be POST", "method"));
      return;
    }
    if (rec.url !== endpoint) {
      errors.push(lineError(line, "mismatched_endpoint", `url must be ${endpoint}`, "url"));
      return;
    }
    const body = asRecord(rec.body);
    if (!body) {
      errors.push(lineError(line, "invalid_request", "body must be a JSON object", "body"));
      return;
    }
    if (typeof body.model !== "string" || !body.model) {
      errors.push(lineError(line, "missing_model", "body.model is required", "body.model"));
      return;
    }
    if (model && modelAlias(body.model) !== model) {
      errors.push(lineError(line, "mismatched_model", "every request in a batch must use the same model", "body.model"));
      return;
    }
    model = modelAlias(body.model);
    if (body.stream === true) {
      errors.push(lineError(line, "invalid_request", "streaming is not supported in batches", "body.stream"));
      return;
    }
    lines.push({ line, customId, body });
  });
  if (!lines.length && !errors.length) errors.push(lineError(0, "empty_file", "the input file has no requests"));
  if (lines.length > MAX_BATCH_REQUESTS) {
    errors.push(lineError(0, "too_many_requests", `a batch may contain at most ${MAX_BATCH_REQUESTS} requests`));
  }
  return { lines, errors, model };
}

export function batchObject(input: {
  id: string;
  endpoint: BatchEndpoint;
  model: string;
  inputFileId: string;
  createdAt: number;
  total: number;
  metadata: JsonMap | null;
}): JsonMap {
  return {
    id: input.id,
    object: "batch",
    endpoint: input.endpoint,
    model: input.model,
    errors: null,
    input_file_id: input.inputFileId,
    completion_window: BATCH_WINDOW,
    status: "validating",
    output_file_id: null,
    error_file_id: null,
    created_at: input.createdAt,
    in_progress_at: null,
    expires_at: input.createdAt + BATCH_WINDOW_SECONDS,
    finalizing_at: null,
    completed_at: null,
    failed_at: null,
    expired_at: null,
    cancelling_at: null,
    cancelled_at: null,
    request_counts: { total: input.total, completed: 0, failed: 0 },
    usage: null,
    metadata: input.metadata,
  };
}

export function batchErrors(errors: BatchLineError[]): JsonMap {
  return { object: "list", data: errors.map((error) => ({ ...error, line: error.line || null })) };
}

export function resultLine(customId: string, result: BatchLineResult): JsonMap {
  return {
    id: `batch_req_${newId()}`,
    custom_id: customId,
    response: {
      status_code: result.ok ? 200 : result.status,
      request_id: `req_${newId()}`,
      body: result.ok ? result.body : { error: result.error },
    },
    error: null,
  };
}

export function expiredLine(customId: string, code: string, message: string): JsonMap {
  return { id: `batch_req_${newId()}`, custom_id: customId, response: null, error: { code, message } };
}

export function emptyBatchUsage(): JsonMap {
  return {
    input_tokens: 0,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 0,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 0,
  };
}

function tokens(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function addBatchUsage(total: JsonMap, usage: unknown): JsonMap {
  const rec = asRecord(usage);
  if (!rec) return total;
  const input = tokens(rec.prompt_tokens ?? rec.input_tokens);
  const output = tokens(rec.completion_tokens ?? rec.output_tokens);
  const cached = tokens(
    asRecord(rec.prompt_tokens_details)?.cached_tokens ?? asRecord(rec.input_tokens_details)?.cached_tokens,
  );
  const reasoning = tokens(
    asRecord(rec.completion_tokens_details)?.reasoning_tokens ?? asRecord(rec.output_tokens_details)?.reasoning_tokens,
  );
  const inputDetails = asRecord(total.input_tokens_details) ?? {};
  const outputDetails = asRecord(total.output_tokens_details) ?? {};
  return {
    input_tokens: tokens(total.input_tokens) + input,
    input_tokens_details: { cached_tokens: tokens(inputDetails.cached_tokens) + cached },
    output_tokens: tokens(total.output_tokens) + output,
    output_tokens_details: { reasoning_tokens: tokens(outputDetails.reasoning_tokens) + reasoning },
    total_tokens: tokens(total.total_tokens) + input + output,
  };
}

export function jsonl(lines: JsonMap[]): Buffer {
  return Buffer.from(lines.map((line) => JSON.stringify(line)).join("\n") + (lines.length ? "\n" : ""));
}
