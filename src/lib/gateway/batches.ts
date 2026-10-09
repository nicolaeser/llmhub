import "server-only";
import prisma from "@/lib/db/prisma";
import { logger } from "@/lib/logging/logger";
import {
  addBatchUsage,
  BATCH_DONE,
  BATCH_ENDPOINTS,
  BATCH_QUEUED,
  BATCH_RESULT_PURPOSE,
  BATCH_RUNNING,
  BATCH_TERMINAL,
  BATCH_WINDOW,
  batchErrors,
  batchObject,
  emptyBatchUsage,
  expiredLine,
  isBatchEndpoint,
  jsonl,
  parseBatchInput,
  resultLine,
} from "@/lib/gateway/batch-format";
import { assertBudget, usageFromUnknown } from "@/lib/gateway/billing";
import { dispatchChat } from "@/lib/gateway/chat";
import { asRecord, asStringMap, newId, ownerId } from "@/lib/gateway/core";
import { resolveChatFiles, resolveResponsesFiles } from "@/lib/gateway/file-refs";
import { allowEndpoint, allowModel, applyPii, modelChain, modelOf, toGateError, withTrace } from "@/lib/gateway/gate";
import { GateError, openAIErrorBody } from "@/lib/gateway/errors";
import { meter } from "@/lib/gateway/meter";
import {
  canReadObject,
  getObject,
  listObjects,
  payloadJson,
  putObject,
  updateObjectPayload,
} from "@/lib/gateway/objects";
import { keyPrincipal } from "@/lib/gateway/principal";
import {
  chatToCompletion,
  chatToResponse,
  completionPrompts,
  completionToChat,
  pageItems,
  parseRequest,
  responseId,
  responseSkeleton,
  responsesToChat,
  visibleResponse,
} from "@/lib/gateway/responses";
import { previousConversation } from "@/lib/gateway/responses-store";
import { forwardToModel } from "@/lib/gateway/upstream";
import { completionsRequestSchema } from "@/schemas/completions";
import { responsesRequestSchema } from "@/schemas/responses";
import type { BatchEndpoint, BatchLineResult, BatchSnapshot } from "@/types/batches";
import type { GatewayErrorCode } from "@/types/errors";
import type { JsonMap, Principal } from "@/types/gateway";

const QUEUED = BATCH_QUEUED;
const DONE = BATCH_DONE;
const RUNNING = BATCH_RUNNING;
const LEASE_MS = 30 * 60_000;
const PROGRESS_EVERY = 10;
const SWEEP_LIMIT = 20;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function invalid(
  message: string,
  param: string | null,
  code: GatewayErrorCode = "invalid_request",
): GateError {
  return new GateError(400, code, message, { param });
}

function snapshotOf(principal: Principal): BatchSnapshot {
  return {
    actor: principal.actor,
    keyId: principal.key?.token_id ?? "",
    teamId: principal.teamId,
    orgId: principal.orgId,
    userId: principal.userId,
    memberId: principal.memberId,
    models: principal.models,
  };
}

async function restorePrincipal(meta: JsonMap): Promise<Principal | null> {
  const snap = asRecord(meta.snapshot);
  if (!snap) return null;
  const keyId = typeof snap.keyId === "string" ? snap.keyId : "";
  if (keyId) return keyPrincipal(keyId);
  return {
    actor: String(snap.actor ?? ""),
    teamId: String(snap.teamId ?? ""),
    orgId: String(snap.orgId ?? ""),
    userId: String(snap.userId ?? ""),
    memberId: String(snap.memberId ?? ""),
    models: Array.isArray(snap.models) ? snap.models.filter((m): m is string => typeof m === "string") : [],
    routeLimits: {},
  };
}

async function readBatch(id: string): Promise<{ batch: JsonMap; meta: JsonMap; owner: string } | null> {
  const object = await getObject(id);
  if (!object || object.kind !== "batch") return null;
  return { batch: asRecord(payloadJson(object)) ?? {}, meta: object.meta, owner: object.owner };
}

async function saveBatch(id: string, batch: JsonMap): Promise<JsonMap> {
  const current = await readBatch(id);
  if (current?.batch.status === "cancelling" && batch.status === "in_progress") {
    batch.status = "cancelling";
    batch.cancelling_at = current.batch.cancelling_at ?? now();
  }
  await updateObjectPayload(id, Buffer.from(JSON.stringify(batch)));
  return batch;
}

async function setPurpose(id: string, from: string, to: string): Promise<boolean> {
  const updated = await prisma.storedObject.updateMany({ where: { id, purpose: from }, data: { purpose: to } });
  return updated.count === 1;
}

function claimable(purpose: string, at = Date.now()): boolean {
  if (purpose === QUEUED) return true;
  if (!purpose.startsWith(RUNNING)) return false;
  return Number(purpose.slice(RUNNING.length)) < at;
}

export async function createBatch(principal: Principal, body: JsonMap): Promise<JsonMap> {
  const inputFileId = typeof body.input_file_id === "string" ? body.input_file_id : "";
  if (!inputFileId) throw invalid("input_file_id is required", "input_file_id", "missing_required_parameter");
  const endpoint = body.endpoint ?? "/v1/chat/completions";
  if (!isBatchEndpoint(endpoint)) {
    throw invalid(`endpoint must be one of ${Object.keys(BATCH_ENDPOINTS).join(", ")}`, "endpoint", "unsupported_endpoint");
  }
  allowEndpoint(principal, endpoint, "endpoint");
  if (body.completion_window !== undefined && body.completion_window !== BATCH_WINDOW) {
    throw invalid(`completion_window must be ${BATCH_WINDOW}`, "completion_window");
  }
  const source = await getObject(inputFileId);
  if (!source || source.kind !== "file" || !canReadObject(source, principal)) {
    throw new GateError(404, "not_found", "input file not found", { param: "input_file_id" });
  }
  const parsed = parseBatchInput(Buffer.from(source.payload).toString("utf8"), endpoint);
  if (parsed.model) allowModel(principal, parsed.model);
  const metadata = asRecord(body.metadata) ? asStringMap(body.metadata) : null;
  const createdAt = now();
  const failed = parsed.errors.length > 0;
  const stored = await putObject({
    kind: "batch",
    owner: ownerId(principal),
    purpose: failed ? DONE : QUEUED,
    contentType: "application/json",
    payload: Buffer.from("{}"),
    meta: { endpoint, snapshot: snapshotOf(principal) },
  });
  const batch = batchObject({
    id: stored.id,
    endpoint,
    model: parsed.model,
    inputFileId,
    createdAt,
    total: failed ? 0 : parsed.lines.length,
    metadata,
  });
  if (failed) {
    batch.status = "failed";
    batch.failed_at = createdAt;
    batch.errors = batchErrors(parsed.errors);
  }
  await updateObjectPayload(stored.id, Buffer.from(JSON.stringify(batch)));
  return batch;
}

export async function listBatches(
  principal: Principal,
  query: { after: string | null; limit: string | null },
): Promise<JsonMap> {
  const rows = (await listObjects("batch", ownerId(principal))).map((row) => ({ id: row.id })).reverse();
  const page = pageItems(rows, { after: query.after, limit: query.limit, order: "desc" });
  const data: JsonMap[] = [];
  for (const row of page.data as JsonMap[]) {
    const object = await getObject(String(row.id));
    const batch = object ? asRecord(payloadJson(object)) : null;
    if (typeof batch?.id === "string") data.push(batch);
  }
  return { ...page, data, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null };
}

export async function cancelBatch(principal: Principal, id: string): Promise<JsonMap> {
  const object = await getObject(id);
  if (!object || object.kind !== "batch" || !canReadObject(object, principal)) {
    throw new GateError(404, "not_found", "batch not found", { param: "id" });
  }
  const batch = asRecord(payloadJson(object)) ?? {};
  const status = String(batch.status ?? "");
  if (status === "cancelling" || status === "cancelled") return batch;
  if (BATCH_TERMINAL.has(status)) {
    throw new GateError(409, "batch_not_cancellable", `cannot cancel a batch with status ${status}`);
  }
  const at = now();
  if (object.purpose === QUEUED && (await setPurpose(id, QUEUED, DONE))) {
    return saveBatch(id, { ...batch, status: "cancelled", cancelling_at: at, cancelled_at: at });
  }
  const next = { ...batch, status: "cancelling", cancelling_at: at };
  await updateObjectPayload(id, Buffer.from(JSON.stringify(next)));
  return next;
}

function errorBody(err: unknown): { status: number; error: JsonMap } {
  const gate = toGateError(err);
  return { status: gate.status, error: openAIErrorBody(gate).error };
}

async function forwardLine(principal: Principal, model: string, path: string, body: JsonMap): Promise<JsonMap> {
  const aliases = modelChain(principal, model, body);
  const usage = meter(principal, model, body);
  try {
    const hit = await forwardToModel(aliases, principal.routeLimits, path, body);
    await usage.ok(hit, usageFromUnknown(asRecord(hit.json)?.usage, hit.json));
    return asRecord(hit.json) ?? {};
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
}

async function completeLine(principal: Principal, model: string, body: JsonMap, outputPii: string[] | null): Promise<JsonMap> {
  const parsed = parseRequest(completionsRequestSchema, body);
  if (!parsed.ok) throw invalid(parsed.message, parsed.param);
  const prompts = completionPrompts(parsed.data);
  const results = await Promise.all(
    prompts.map((prompt) =>
      dispatchChat({
        principal,
        model,
        body: completionToChat(parsed.data, prompt),
        aliases: modelChain(principal, model, body),
        outputPii,
      }),
    ),
  );
  return chatToCompletion(
    results.map((result) => result.json),
    { id: `cmpl-${newId()}`, created: now(), model, n: parsed.data.n ?? 1, prompts, echo: parsed.data.echo === true },
  );
}

async function respondLine(principal: Principal, model: string, body: JsonMap, outputPii: string[] | null): Promise<JsonMap> {
  const clean = await resolveResponsesFiles(body, principal);
  const parsed = parseRequest(responsesRequestSchema, clean);
  if (!parsed.ok) throw invalid(parsed.message, parsed.param);
  const request = parsed.data;
  const history = request.previous_response_id ? await previousConversation(request.previous_response_id, principal) : [];
  const { body: chatBody } = responsesToChat(request, history);
  const dispatched = await dispatchChat({ principal, model, body: chatBody, aliases: modelChain(principal, model, clean), outputPii });
  const response = chatToResponse(dispatched.json, responseSkeleton(request, responseId(newId()), now()));
  return visibleResponse({ ...response, store: false }, request.include ?? null);
}

export async function runBatchLine(owner: Principal, endpoint: BatchEndpoint, raw: JsonMap): Promise<BatchLineResult> {
  const principal = withTrace(owner, `batch:${endpoint}`);
  try {
    allowEndpoint(principal, endpoint);
    await assertBudget(principal);
    const model = modelOf(raw);
    allowModel(principal, model);
    const { body, output } = await applyPii(raw, principal);
    if (endpoint === "/v1/chat/completions") {
      const clean = await resolveChatFiles(body, principal);
      const dispatched = await dispatchChat({ principal, model, body: clean, aliases: modelChain(principal, model, clean), outputPii: output });
      return { ok: true, body: dispatched.json, usage: dispatched.json.usage };
    }
    const json =
      endpoint === "/v1/completions"
        ? await completeLine(principal, model, body, output)
        : endpoint === "/v1/responses"
          ? await respondLine(principal, model, body, output)
          : await forwardLine(principal, model, BATCH_ENDPOINTS[endpoint], body);
    return { ok: true, body: json, usage: json.usage };
  } catch (err) {
    const failure = errorBody(err);
    return { ok: false, status: failure.status, error: failure.error };
  }
}

async function writeResults(owner: string, name: string, purpose: string, lines: JsonMap[]): Promise<string | null> {
  if (!lines.length) return null;
  const file = await putObject({
    kind: "file",
    owner,
    filename: name,
    purpose,
    contentType: "application/jsonl",
    payload: jsonl(lines),
  });
  return file.id;
}

async function finishBatch(id: string, purpose: string, batch: JsonMap): Promise<void> {
  await saveBatch(id, batch);
  await setPurpose(id, purpose, DONE);
}

export async function processBatch(id: string): Promise<void> {
  const row = await prisma.storedObject.findUnique({ where: { id }, select: { kind: true, purpose: true } });
  if (!row || row.kind !== "batch" || !claimable(row.purpose)) return;
  let lease = `${RUNNING}${Date.now() + LEASE_MS}`;
  if (!(await setPurpose(id, row.purpose, lease))) return;
  const loaded = await readBatch(id);
  if (!loaded) return;
  const { meta, owner } = loaded;
  let batch = loaded.batch;
  const fail = (code: string, message: string) =>
    finishBatch(id, lease, {
      ...batch,
      status: "failed",
      failed_at: now(),
      errors: batchErrors([{ code, message, line: 0, param: null }]),
    });
  if (row.purpose !== QUEUED) {
    await fail("processing_interrupted", "batch processing stopped before completion; resubmit the batch");
    return;
  }
  const endpoint = meta.endpoint;
  const principal = await restorePrincipal(meta);
  const source = typeof batch.input_file_id === "string" ? await getObject(batch.input_file_id) : null;
  if (!isBatchEndpoint(endpoint) || !principal || !source) {
    await fail("batch_unavailable", "the batch key, input file, or endpoint is no longer available");
    return;
  }
  const { lines } = parseBatchInput(Buffer.from(source.payload).toString("utf8"), endpoint);
  batch = await saveBatch(id, { ...batch, status: "in_progress", in_progress_at: now() });
  const output: JsonMap[] = [];
  const errors: JsonMap[] = [];
  let usage = emptyBatchUsage();
  let stop: "cancelled" | "expired" | null = batch.status === "cancelling" ? "cancelled" : null;
  for (const [index, line] of lines.entries()) {
    if (!stop && now() >= Number(batch.expires_at ?? Infinity)) stop = "expired";
    if (!stop) {
      const next = `${RUNNING}${Date.now() + LEASE_MS}`;
      if (!(await setPurpose(id, lease, next))) return;
      lease = next;
    }
    if (!stop && index > 0 && index % PROGRESS_EVERY === 0) {
      batch = await saveBatch(id, {
        ...batch,
        request_counts: { total: lines.length, completed: output.length, failed: errors.length },
        usage,
      });
      if (batch.status === "cancelling") stop = "cancelled";
    }
    if (stop === "expired") {
      errors.push(expiredLine(line.customId, "batch_expired", "This request could not be executed before the completion window expired."));
      continue;
    }
    if (stop === "cancelled") {
      errors.push(expiredLine(line.customId, "batch_cancelled", "This request was not executed because the batch was cancelled."));
      continue;
    }
    const result = await runBatchLine(principal, endpoint, line.body);
    if (result.ok) {
      usage = addBatchUsage(usage, result.usage);
      output.push(resultLine(line.customId, result));
    } else {
      errors.push(resultLine(line.customId, result));
    }
  }
  batch = await saveBatch(id, { ...batch, status: stop === "cancelled" ? "cancelling" : "finalizing", finalizing_at: now() });
  const outputFileId = await writeResults(owner, "batch-output.jsonl", BATCH_RESULT_PURPOSE, output);
  const errorFileId = await writeResults(owner, "batch-errors.jsonl", BATCH_RESULT_PURPOSE, errors);
  const at = now();
  const status = stop ?? "completed";
  await finishBatch(id, lease, {
    ...batch,
    status,
    output_file_id: outputFileId,
    error_file_id: errorFileId,
    request_counts: { total: lines.length, completed: output.length, failed: errors.length },
    usage,
    ...(status === "completed" ? { completed_at: at } : status === "expired" ? { expired_at: at } : { cancelled_at: at }),
  });
}

export function startBatch(id: string): void {
  void processBatch(id).catch((err) => {
    logger.error("batch.failed", { batchId: id, err: err instanceof Error ? err.message : String(err) });
  });
}

export async function runPendingBatches(): Promise<number> {
  const rows = await prisma.storedObject.findMany({
    where: { kind: "batch", OR: [{ purpose: QUEUED }, { purpose: { startsWith: RUNNING } }] },
    select: { id: true, purpose: true },
    orderBy: { createdAt: "asc" },
    take: SWEEP_LIMIT,
  });
  const ready = rows.filter((row) => claimable(row.purpose));
  for (const row of ready) startBatch(row.id);
  return ready.length;
}
