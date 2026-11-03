import { chatReply, gateway, gatewayRequest, MODEL, resetGateway, virtualKeyRow } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { GateError } from "@/lib/gateway/errors";
import {
  claimIdempotencyKey,
  IDEMPOTENCY_KIND,
  IDEMPOTENCY_STALE_MS,
  IDEMPOTENCY_TTL_MS,
  idempotencyRowId,
  idempotencyScope,
  idempotent,
  IDEMPOTENT_REPLAYED_HEADER,
  jsonFingerprint,
  MAX_IDEMPOTENCY_KEYS,
  MAX_IDEMPOTENT_BODY_BYTES,
  purgeIdempotencyKeys,
} from "@/lib/gateway/storage/idempotency";
import { bindPiiVault, PiiVault } from "@/lib/gateway/safety/pii-vault";
import type { JsonMap, Principal } from "@/types/gateway";

type Row = {
  id: string;
  kind: string;
  owner: string;
  filename: string;
  purpose: string;
  contentType: string;
  bytes: number;
  payload: Uint8Array | null;
  meta: unknown;
  createdAt: Date;
};

type Where = Record<string, unknown>;

const rows = new Map<string, Row>();
let nextId = 0;

function fieldMatches(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (expected && typeof expected === "object") {
    const condition = expected as Record<string, unknown>;
    if ("in" in condition) return (condition.in as unknown[]).includes(actual);
    if ("lt" in condition) return (actual as Date).getTime() < (condition.lt as Date).getTime();
    if ("startsWith" in condition) return String(actual).startsWith(String(condition.startsWith));
    if ("not" in condition) return actual !== condition.not;
    return false;
  }
  return actual === expected;
}

function matches(row: Row, where: Where = {}): boolean {
  return Object.entries(where).every(([field, expected]) => {
    if (field === "OR") return (expected as Where[]).some((part) => matches(row, part));
    if (field === "NOT") return !(expected as Where[]).some((part) => matches(row, part));
    return fieldMatches(row[field as keyof Row], expected);
  });
}

function duplicateKey(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

const storedObject = {
  findUnique: ({ where }: { where: { id: string } }) => {
    const row = rows.get(where.id);
    return row ? { ...row } : null;
  },
  findMany: ({ where, take }: { where?: Where; take?: number }) =>
    [...rows.values()]
      .filter((row) => matches(row, where))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, take ?? Infinity)
      .map((row) => ({ ...row })),
  count: ({ where }: { where?: Where }) => [...rows.values()].filter((row) => matches(row, where)).length,
  create: ({ data }: { data: Partial<Row> }) => {
    const id = data.id ?? `obj-${(nextId += 1)}`;
    if (rows.has(id)) throw duplicateKey();
    const row: Row = {
      id,
      kind: data.kind ?? "",
      owner: data.owner ?? "",
      filename: data.filename ?? "",
      purpose: data.purpose ?? "",
      contentType: data.contentType ?? "",
      bytes: data.bytes ?? 0,
      payload: data.payload ?? null,
      meta: data.meta ?? {},
      createdAt: data.createdAt ?? new Date(),
    };
    rows.set(id, row);
    return { ...row };
  },
  update: ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
    const row = rows.get(where.id);
    if (!row) throw Object.assign(new Error("not found"), { code: "P2025" });
    Object.assign(row, data);
    return { ...row };
  },
  updateMany: ({ where, data }: { where: Where; data: Partial<Row> }) => {
    const hit = [...rows.values()].filter((row) => matches(row, where));
    for (const row of hit) Object.assign(row, data);
    return { count: hit.length };
  },
  delete: ({ where }: { where: { id: string } }) => {
    const row = rows.get(where.id);
    rows.delete(where.id);
    return row;
  },
  deleteMany: ({ where }: { where: Where }) => {
    const hit = [...rows.values()].filter((row) => matches(row, where));
    for (const row of hit) rows.delete(row.id);
    return { count: hit.length };
  },
};

function reset(): void {
  resetGateway();
  rows.clear();
  recordedPrisma.handlers = { storedObject };
}

function principal(userId: string, pool: Principal["pool"] = "api"): Principal {
  return {
    actor: userId,
    teamId: "",
    orgId: "",
    userId,
    memberId: "",
    models: [],
    routeLimits: {},
    pool,
    trace: {
      endpoint: "/api/v1/batches",
      piiMode: "",
      piiInput: new Set(),
      piiOutput: new Set(),
      guardInput: new Set(),
      guardOutput: new Set(),
      guardBlocked: false,
    },
  };
}

function request(key: string | null, body: JsonMap = { input_file_id: "file-1" }, path = "/api/v1/batches"): Request {
  return gatewayRequest(path, body, key === null ? {} : { "Idempotency-Key": key });
}

async function call(
  req: Request,
  caller: Principal,
  run: () => Promise<Response>,
  finishedEvents?: readonly string[],
): Promise<Response> {
  const body = (await req.clone().json()) as JsonMap;
  try {
    return await idempotent({ req, principal: caller, fingerprint: () => jsonFingerprint(req, body), finishedEvents }, run);
  } catch (err) {
    if (err instanceof GateError) {
      return Response.json({ error: { code: err.code, message: err.message, param: err.param } }, { status: err.status });
    }
    throw err;
  }
}

function counter(reply: () => Response = () => Response.json({ id: "batch-1" })) {
  const state = { runs: 0 };
  return {
    state,
    run: async () => {
      state.runs += 1;
      return reply();
    },
  };
}

function idempotencyRows(): Row[] {
  return [...rows.values()].filter((row) => row.kind === IDEMPOTENCY_KIND);
}

async function errorCode(res: Response): Promise<string> {
  return String(((await res.json()) as { error: { code: string } }).error.code);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sse(events: string[]): Response {
  return new Response(events.join(""), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

test("a first call stores its answer and a repeat replays it without running the handler", async () => {
  reset();
  const caller = principal("user-a");
  const handler = counter(() => Response.json({ id: "batch-1", n: Math.random() }, { status: 201 }));
  const first = await call(request("key-1"), caller, handler.run);
  const firstBody = await first.text();
  assert.equal(first.status, 201);
  assert.equal(first.headers.get(IDEMPOTENT_REPLAYED_HEADER), null);
  const second = await call(request("key-1"), caller, handler.run);
  assert.equal(second.status, 201);
  assert.equal(second.headers.get(IDEMPOTENT_REPLAYED_HEADER), "true");
  assert.match(second.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(await second.text(), firstBody);
  assert.equal(handler.state.runs, 1);
  assert.equal(idempotencyRows().length, 1);
  assert.equal(idempotencyRows()[0]!.purpose, "done");
});

test("the fingerprint ignores key order but a different body answers 409 idempotency_key_reused", async () => {
  reset();
  const caller = principal("user-a");
  const handler = counter();
  await call(request("key-1", { a: 1, b: { c: 2, d: 3 } }), caller, handler.run);
  const reordered = await call(request("key-1", { b: { d: 3, c: 2 }, a: 1 }), caller, handler.run);
  assert.equal(reordered.headers.get(IDEMPOTENT_REPLAYED_HEADER), "true");
  const changed = await call(request("key-1", { a: 2 }), caller, handler.run);
  assert.equal(changed.status, 409);
  assert.equal(await errorCode(changed), "idempotency_key_reused");
  assert.equal(handler.state.runs, 1);
});

test("a duplicate while the first request runs answers 409 idempotency_key_in_progress", async () => {
  reset();
  const caller = principal("user-a");
  const gate = deferred<Response>();
  const first = call(request("key-1"), caller, () => gate.promise);
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await call(request("key-1"), caller, async () => Response.json({ duplicate: true }));
  assert.equal(duplicate.status, 409);
  assert.equal(await errorCode(duplicate), "idempotency_key_in_progress");
  gate.resolve(Response.json({ id: "batch-1" }));
  assert.equal((await first).status, 200);
  const replay = await call(request("key-1"), caller, async () => Response.json({ duplicate: true }));
  assert.deepEqual(await replay.json(), { id: "batch-1" });
});

test("a failed request releases the key so a retry runs", async () => {
  reset();
  const caller = principal("user-a");
  const thrown = await call(request("key-1"), caller, async () => {
    throw new GateError(502, "upstream_error", "upstream failed");
  });
  assert.equal(thrown.status, 502);
  assert.equal(idempotencyRows().length, 0);
  const refused = await call(request("key-1"), caller, async () => Response.json({ error: "busy" }, { status: 503 }));
  assert.equal(refused.status, 503);
  assert.equal(idempotencyRows().length, 0);
  const handler = counter();
  const retried = await call(request("key-1"), caller, handler.run);
  assert.equal(retried.status, 200);
  assert.equal(retried.headers.get(IDEMPOTENT_REPLAYED_HEADER), null);
  assert.equal(handler.state.runs, 1);
});

test("replays stay inside the principal, endpoint, and surface", async () => {
  reset();
  const alice = await call(request("shared"), principal("user-a"), async () => Response.json({ owner: "a" }));
  assert.deepEqual(await alice.json(), { owner: "a" });
  const bob = await call(request("shared"), principal("user-b"), async () => Response.json({ owner: "b" }));
  assert.equal(bob.headers.get(IDEMPOTENT_REPLAYED_HEADER), null);
  assert.deepEqual(await bob.json(), { owner: "b" });
  const otherEndpoint = await call(request("shared", undefined, "/api/v1/videos"), principal("user-a"), async () =>
    Response.json({ endpoint: "videos" }),
  );
  assert.deepEqual(await otherEndpoint.json(), { endpoint: "videos" });
  const otherSurface = await call(
    request("shared", undefined, "/api/subscription/v1/responses"),
    principal("user-a", "subscription"),
    async () => Response.json({ surface: "subscription" }),
  );
  const sameEndpointApi = await call(request("shared", undefined, "/api/v1/responses"), principal("user-a"), async () =>
    Response.json({ surface: "api" }),
  );
  assert.deepEqual(await otherSurface.json(), { surface: "subscription" });
  assert.deepEqual(await sameEndpointApi.json(), { surface: "api" });
  assert.equal(idempotencyRows().length, 5);
  const aliceAgain = await call(request("shared"), principal("user-a"), async () => Response.json({ owner: "rerun" }));
  assert.deepEqual(await aliceAgain.json(), { owner: "a" });
  const req = request("shared");
  assert.notEqual(
    idempotencyRowId(idempotencyScope(req, principal("user-a")), "shared"),
    idempotencyRowId(idempotencyScope(req, principal("user-b")), "shared"),
  );
});

test("invalid keys answer 400 invalid_request on Idempotency-Key", async () => {
  for (const key of ["", "é", "a".repeat(256), "line\tbreak"]) {
    reset();
    const handler = counter();
    const res = await call(request(key), principal("user-a"), handler.run);
    assert.equal(res.status, 400, JSON.stringify(key));
    const body = (await res.json()) as { error: { code: string; param: string } };
    assert.equal(body.error.code, "invalid_request");
    assert.equal(body.error.param, "Idempotency-Key");
    assert.equal(handler.state.runs, 0);
  }
  reset();
  const longest = await call(request("k".repeat(255)), principal("user-a"), counter().run);
  assert.equal(longest.status, 200);
});

test("requests without the header run without touching the idempotency store", async () => {
  reset();
  const handler = counter();
  await call(request(null), principal("user-a"), handler.run);
  await call(request(null), principal("user-a"), handler.run);
  assert.equal(handler.state.runs, 2);
  assert.equal(recordedPrisma.called("storedObject").length, 0);
});

test("more than the live key cap per principal answers 429 after expired rows are purged", async () => {
  reset();
  const owner = "user-a";
  const now = Date.now();
  for (let index = 0; index < MAX_IDEMPOTENCY_KEYS; index += 1) {
    storedObject.create({
      data: { id: `idem_seed_${index}`, kind: IDEMPOTENCY_KIND, owner, purpose: "done", createdAt: new Date(now - 1000) },
    });
  }
  storedObject.create({
    data: { id: "idem_other", kind: IDEMPOTENCY_KIND, owner: "user-b", purpose: "done", createdAt: new Date(now) },
  });
  const handler = counter();
  const capped = await call(request("one-more"), principal(owner), handler.run);
  assert.equal(capped.status, 429);
  assert.equal(await errorCode(capped), "rate_limit_exceeded");
  assert.equal(handler.state.runs, 0);
  rows.get("idem_seed_0")!.createdAt = new Date(now - IDEMPOTENCY_TTL_MS - 1);
  const admitted = await call(request("one-more"), principal(owner), handler.run);
  assert.equal(admitted.status, 200);
  assert.equal(rows.has("idem_seed_0"), false);
  assert.equal(handler.state.runs, 1);
});

test("an expired key runs again and a stale pending claim can be taken over", async () => {
  reset();
  const caller = principal("user-a");
  const handler = counter(() => Response.json({ run: handler.state.runs }));
  await call(request("key-1"), caller, handler.run);
  const [row] = idempotencyRows();
  row!.createdAt = new Date(Date.now() - IDEMPOTENCY_TTL_MS - 1);
  const rerun = await call(request("key-1", { other: true }), caller, handler.run);
  assert.equal(rerun.headers.get(IDEMPOTENT_REPLAYED_HEADER), null);
  assert.deepEqual(await rerun.json(), { run: 2 });

  const scope = idempotencyScope(request("key-2"), caller);
  const fingerprint = jsonFingerprint(request("key-2"), { input_file_id: "file-1" });
  const crashed = await claimIdempotencyKey(scope, "key-2", fingerprint, Date.now() - IDEMPOTENCY_STALE_MS - 1);
  assert.equal(crashed.kind, "claimed");
  const takeover = await call(request("key-2"), caller, handler.run);
  assert.equal(takeover.status, 200);
  assert.equal(handler.state.runs, 3);
  const fresh = await claimIdempotencyKey(idempotencyScope(request("key-3"), caller), "key-3", fingerprint);
  assert.equal(fresh.kind, "claimed");
  const blocked = await call(request("key-3"), caller, handler.run);
  assert.equal(await errorCode(blocked), "idempotency_key_in_progress");
});

test("an answer above the body cap is delivered once and later replays answer 409", async () => {
  reset();
  const caller = principal("user-a");
  const large = "x".repeat(MAX_IDEMPOTENT_BODY_BYTES + 1);
  const handler = counter(() => new Response(large, { headers: { "content-type": "text/plain" } }));
  const first = await call(request("key-1"), caller, handler.run);
  assert.equal((await first.text()).length, large.length);
  const [row] = idempotencyRows();
  assert.equal(row!.payload, null);
  assert.equal(row!.purpose, "done");
  const replay = await call(request("key-1"), caller, handler.run);
  assert.equal(replay.status, 409);
  const body = (await replay.json()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "idempotency_key_reused");
  assert.match(body.error.message, /larger than/);
  assert.equal(handler.state.runs, 1);
});

test("an answer with restored personal data is never stored for replay", async () => {
  reset();
  const caller = principal("user-a");
  const vault = new PiiVault();
  vault.placeholder("EMAIL", "a@example.com");
  bindPiiVault(caller.trace!, vault);
  const handler = counter(() => Response.json({ text: "a@example.com" }));
  await call(request("key-1"), caller, handler.run);
  assert.equal(idempotencyRows()[0]!.payload, null);
  const replay = await call(request("key-1"), caller, handler.run);
  assert.equal(replay.status, 409);
  assert.doesNotMatch(JSON.stringify(idempotencyRows()), /example\.com/);
});

test("a finished stream keeps the key without a body, an unfinished or cancelled stream releases it", async () => {
  const finishedEvents = ["event: response.completed\n"];
  reset();
  const caller = principal("user-a");
  const streamed = counter(() => sse(["event: response.created\ndata: {}\n\n", "event: response.comp", "leted\ndata: {}\n\n"]));
  const first = await call(request("stream-ok"), caller, streamed.run, finishedEvents);
  assert.match(await first.text(), /response\.completed/);
  assert.equal(idempotencyRows()[0]!.purpose, "done");
  const replay = await call(request("stream-ok"), caller, streamed.run, finishedEvents);
  assert.equal(replay.status, 409);
  assert.match(((await replay.json()) as { error: { message: string } }).error.message, /stream/);
  assert.equal(streamed.state.runs, 1);

  reset();
  const failed = await call(request("stream-failed"), caller, async () => sse(["event: response.failed\ndata: {}\n\n"]), finishedEvents);
  await failed.text();
  assert.equal(idempotencyRows().length, 0);

  const empty = await call(request("stream-empty"), caller, async () => sse([]), finishedEvents);
  await empty.text();
  assert.equal(idempotencyRows().length, 0);

  const open = await call(
    request("stream-cancel"),
    caller,
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("event: response.created\ndata: {}\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    finishedEvents,
  );
  const reader = open.body!.getReader();
  await reader.read();
  assert.equal(idempotencyRows().length, 1);
  await reader.cancel();
  assert.equal(idempotencyRows().length, 0);
});

test("the sweep deletes only expired idempotency rows", async () => {
  reset();
  const now = new Date();
  storedObject.create({ data: { id: "idem_old", kind: IDEMPOTENCY_KIND, purpose: "done", createdAt: new Date(now.getTime() - IDEMPOTENCY_TTL_MS - 1) } });
  storedObject.create({ data: { id: "idem_new", kind: IDEMPOTENCY_KIND, purpose: "done", createdAt: now } });
  storedObject.create({ data: { id: "old-file", kind: "file", createdAt: new Date(0) } });
  assert.equal(await purgeIdempotencyKeys(now), 1);
  assert.deepEqual([...rows.keys()].sort(), ["idem_new", "old-file"]);
});

async function filesPost(body: unknown, key: string): Promise<Response> {
  const { POST } = await import("@/app/api/v1/files/route");
  return POST(gatewayRequest("/api/v1/files", body, { "Idempotency-Key": key }));
}

function multipartUpload(content: string, key: string): Request {
  const form = new FormData();
  form.set("purpose", "batch");
  form.set("file", new File([content], "input.jsonl", { type: "application/jsonl" }));
  return new Request("http://hub.local/api/v1/files", {
    method: "POST",
    headers: { authorization: `Bearer ${gateway.key.prefix}`, "Idempotency-Key": key },
    body: form,
  });
}

function storedFiles(): Row[] {
  return [...rows.values()].filter((row) => row.kind === "file");
}

test("POST /api/v1/files replays JSON and multipart uploads per key", async () => {
  reset();
  const first = await filesPost({ filename: "a.txt", purpose: "assistants", content: "hello" }, "upload-1");
  const created = (await first.json()) as { id: string };
  const replay = await filesPost({ purpose: "assistants", content: "hello", filename: "a.txt" }, "upload-1");
  assert.equal(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER), "true");
  assert.equal(((await replay.json()) as { id: string }).id, created.id);
  assert.equal(storedFiles().length, 1);

  const { POST } = await import("@/app/api/v1/files/route");
  const upload = await POST(multipartUpload('{"a":1}', "upload-2"));
  const uploaded = (await upload.json()) as { id: string };
  const again = await POST(multipartUpload('{"a":1}', "upload-2"));
  assert.equal(((await again.json()) as { id: string }).id, uploaded.id);
  const changed = await POST(multipartUpload('{"a":2}', "upload-2"));
  assert.equal(changed.status, 409);
  assert.equal(await errorCode(changed), "idempotency_key_reused");
  assert.equal(storedFiles().length, 2);
});

test("POST /api/v1/batches replays a created batch without creating another", async () => {
  reset();
  storedObject.create({
    data: { id: "file-1", kind: "file", owner: gateway.key.id, payload: Buffer.from("not json\n"), createdAt: new Date() },
  });
  const { POST } = await import("@/app/api/v1/batches/route");
  const body = { input_file_id: "file-1", endpoint: "/v1/chat/completions", completion_window: "24h" };
  const first = await POST(gatewayRequest("/api/v1/batches", body, { "Idempotency-Key": "batch-key" }));
  const batch = (await first.json()) as { id: string; status: string };
  assert.equal(batch.status, "failed");
  const replay = await POST(gatewayRequest("/api/v1/batches", body, { "Idempotency-Key": "batch-key" }));
  assert.equal(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER), "true");
  assert.equal(((await replay.json()) as { id: string }).id, batch.id);
  assert.equal([...rows.values()].filter((row) => row.kind === "batch").length, 1);
});

async function responsesPost(body: JsonMap, key: string): Promise<Response> {
  const { POST } = await import("@/app/api/v1/responses/route");
  return POST(gatewayRequest("/api/v1/responses", body, { "Idempotency-Key": key }));
}

test("POST /api/v1/responses replays without calling the upstream again and isolates keys", async () => {
  reset();
  gateway.reply = () => chatReply(`answer ${gateway.upstream.length}`);
  const body = { model: MODEL, input: "Hello" };
  const first = await responsesPost(body, "resp-key");
  assert.equal(first.status, 200);
  const created = (await first.json()) as { id: string };
  const replay = await responsesPost(body, "resp-key");
  assert.equal(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER), "true");
  assert.equal(((await replay.json()) as { id: string }).id, created.id);
  assert.equal(gateway.upstream.length, 1);

  gateway.key = virtualKeyRow({ id: "key-2" });
  const otherKey = await responsesPost(body, "resp-key");
  assert.equal(otherKey.headers.get(IDEMPOTENT_REPLAYED_HEADER), null);
  assert.notEqual(((await otherKey.json()) as { id: string }).id, created.id);
  assert.equal(gateway.upstream.length, 2);
});

test("POST /api/v1/responses with stream keeps the key after a completed stream", async () => {
  reset();
  const chunk = (delta: JsonMap, finish: string | null = null) => ({
    id: "chunk",
    object: "chat.completion.chunk",
    created: 1,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  gateway.reply = () =>
    sse([
      `data: ${JSON.stringify(chunk({ role: "assistant", content: "Hi" }))}\n\n`,
      `data: ${JSON.stringify(chunk({}, "stop"))}\n\n`,
      "data: [DONE]\n\n",
    ]);
  const body = { model: MODEL, input: "Hello", stream: true };
  const first = await responsesPost(body, "stream-key");
  assert.match(await first.text(), /event: response\.completed/);
  assert.equal(idempotencyRows()[0]!.purpose, "done");
  const replay = await responsesPost(body, "stream-key");
  assert.equal(replay.status, 409);
  assert.equal(await errorCode(replay), "idempotency_key_reused");
  assert.equal(gateway.upstream.length, 1);
});
