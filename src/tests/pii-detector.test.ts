import "./support/redactor-env";
import { chatReply, gateway, gatewayRequest, groupRow, resetGateway, type UpstreamCall } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { ensureRedactorProvider, REDACTOR_ALIAS, REDACTOR_PROVIDER_ID, syncRedactorProvider } from "@/lib/bootstrap/redactor-provider";
import { systemPrincipal } from "@/lib/gateway/access/system-principal";
import { GateError } from "@/lib/gateway/errors";
import { applyPiiSpans, piiPatternSpans, redactJSON, redactPii } from "@/lib/gateway/safety/pii";
import { clearPiiDetectorCache, detectPiiSpans, redactWithPolicy } from "@/lib/gateway/safety/pii-detector";
import { CHUNK_CHARS, CHUNK_OVERLAP, chunkText, createSlots, mergePiiSpans, modelEntity, parseDetections } from "@/lib/gateway/safety/pii-spans";
import { PiiVault, withActiveVault } from "@/lib/gateway/safety/pii-vault";
import { testPiiModel } from "@/lib/models/feature-model-test";
import { featureModel } from "@/lib/models/feature-models";
import type { AuthenticatedSession, Permission } from "@/types/auth";
import type { JsonMap } from "@/types/gateway";
import type { PiiPolicy, PiiSpan } from "@/types/guardrails";

const STUB_LABELS: [string, string][] = [
  ["Ada Lovelace", "private_person"],
  ["Anna Schneider", "private_person"],
  ["ada@acme.com", "private_email"],
  ["Hauptstraße 12, 10115 Berlin", "private_address"],
  ["0012345678", "account_number"],
  ["hunter2-Blue!", "secret"],
  ["the phone 415-555-0123", "private_phone"],
];

const received: string[] = [];
let hold: Promise<void> | null = null;

function stubSpans(text: string): JsonMap[] {
  const points = Array.from(text);
  const spans: JsonMap[] = [];
  for (const [value, label] of STUB_LABELS) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(value, from);
      if (at < 0) break;
      const start = Array.from(text.slice(0, at)).length;
      spans.push({ entity_group: label, score: 0.98, start, end: start + Array.from(value).length });
      from = at + value.length;
    }
  }
  assert.ok(spans.every((span) => (span.end as number) <= points.length));
  return spans;
}

async function redactorReply(call: UpstreamCall): Promise<Response> {
  if (!call.url.endsWith("/v1/token-classification")) return chatReply("ok");
  if (hold) await hold;
  const inputs = (call.body?.inputs as string[]) ?? [];
  received.push(...inputs);
  return Response.json(inputs.map(stubSpans));
}

const harnessFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) return reject(signal.reason);
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    harnessFetch(input, init).then(resolve, reject);
  })) as typeof fetch;

let aliasCount = 0;

function redactorAlias(): string {
  aliasCount += 1;
  const alias = `pii-tracer-${aliasCount}`;
  gateway.groups.set(
    alias,
    groupRow(alias, {
      vendor: "",
      deployments: [
        {
          id: `${alias}-route`,
          kind: "openai_compat",
          baseUrl: "",
          model: "pii-tracer",
          weight: 1,
          costInput: 0,
          costOutput: 0,
          providerId: `${alias}-provider`,
          provider: {
            id: `${alias}-provider`,
            kind: "openai_compat",
            baseUrl: "http://redactor.test:8080",
            apiKey: "",
            zdr: false,
            retentionDays: null,
            region: "",
            noTraining: false,
            enabled: true,
            restricted: false,
            internal: true,
            assignments: [],
          },
        },
      ],
    }),
  );
  return alias;
}

function setup(timeoutSeconds = 5): string {
  resetGateway();
  clearPiiDetectorCache();
  received.length = 0;
  hold = null;
  gateway.reply = redactorReply;
  const alias = redactorAlias();
  gateway.enterprise = { pii_detector: { model: alias, timeout_seconds: timeoutSeconds } };
  return alias;
}

function policy(change: Partial<PiiPolicy> = {}): PiiPolicy {
  return { enabled: true, mode: "mask", output: false, entities: [], detector: "both", failure: "patterns", ...change };
}

function chatBody(...contents: string[]): JsonMap {
  return { model: "gpt-test", messages: contents.map((content) => ({ role: "user", content })) };
}

function contentsOf(body: unknown): string[] {
  return ((body as { messages: { content: string }[] }).messages ?? []).map((message) => message.content);
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => {
      console.log = log;
      console.error = error;
    },
  };
}

test("every PII-Tracer label maps onto a catalog entity and tagged or unknown labels are handled", () => {
  assert.deepEqual(
    [
      "private_person",
      "private_email",
      "private_phone",
      "private_address",
      "private_url",
      "private_date",
      "account_number",
      "secret",
      "other_pii",
    ].map(modelEntity),
    ["PERSON", "EMAIL_ADDRESS", "PHONE_NUMBER", "ADDRESS", "URL", "DATE_TIME", "ACCOUNT_NUMBER", "SECRET", "OTHER_PII"],
  );
  assert.equal(modelEntity("S-private_person"), "PERSON");
  assert.equal(modelEntity("B-PER"), "PERSON");
  assert.equal(modelEntity("iban_code"), "IBAN_CODE");
  assert.equal(modelEntity("weather"), null);
});

test("responses are parsed per input, offsets move from code points to UTF-16, and bad shapes are refused", () => {
  const text = "🎉 Ada Lovelace";
  const parsed = parseDetections([[{ entity_group: "private_person", start: 2, end: 14, score: 0.9 }]], [text]);
  assert.deepEqual(parsed, [[{ entity: "PERSON", start: 3, end: 15, score: 0.9 }]]);
  assert.equal(text.slice(3, 15), "Ada Lovelace");
  assert.deepEqual(parseDetections([{ entity: "B-private_email", start: 0, end: 3 }], ["a@b"]), [
    [{ entity: "EMAIL_ADDRESS", start: 0, end: 3, score: 1 }],
  ]);
  assert.deepEqual(parseDetections([[{ entity_group: "weather", start: 0, end: 2 }], []], ["ab", "cd"]), [[], []]);
  assert.equal(parseDetections({ spans: [] }, ["ab"]), null);
  assert.equal(parseDetections([[]], ["ab", "cd"]), null);
  assert.deepEqual(parseDetections([[{ entity_group: "private_person", start: 0, end: 99 }]], ["ab"]), [[]]);
});

test("overlapping model and pattern spans resolve to one span, with credentials, then length, then patterns winning", () => {
  const model = (entity: string, start: number, end: number, score = 0.9): PiiSpan => ({ entity, start, end, score, source: "model" });
  const pattern = (entity: string, start: number, end: number): PiiSpan => ({ entity, start, end, score: 1, source: "pattern" });
  assert.deepEqual(mergePiiSpans([model("PHONE_NUMBER", 3, 15), pattern("PHONE_NUMBER", 0, 15)]), [
    { entity: "PHONE_NUMBER", start: 0, end: 15, score: 1, source: "pattern" },
  ]);
  assert.deepEqual(mergePiiSpans([model("ACCOUNT_NUMBER", 0, 27), pattern("IBAN_CODE", 0, 27)]), [
    { entity: "IBAN_CODE", start: 0, end: 27, score: 1, source: "pattern" },
  ]);
  assert.deepEqual(mergePiiSpans([pattern("PHONE_NUMBER", 10, 20), model("SECRET", 12, 18)]), [
    { entity: "SECRET", start: 10, end: 20, score: 1, source: "model" },
  ]);
  assert.deepEqual(mergePiiSpans([model("PERSON", 0, 4), model("ADDRESS", 10, 20), model("ADDRESS", 15, 30, 0.5)]), [
    { entity: "PERSON", start: 0, end: 4, score: 0.9, source: "model" },
    { entity: "ADDRESS", start: 10, end: 30, score: 0.9, source: "model" },
  ]);
});

test("pattern spans line up with the pattern redaction they come from", () => {
  const text = "Mail ada@acme.com or bob@example.com, card 4111 1111 1111 1111, from 8.8.8.8, again ada@acme.com.";
  const spans = piiPatternSpans(text, []) ?? [];
  assert.deepEqual(
    spans.map((span) => [span.entity, text.slice(span.start, span.end)]),
    [
      ["EMAIL_ADDRESS", "ada@acme.com"],
      ["EMAIL_ADDRESS", "bob@example.com"],
      ["CREDIT_CARD", "4111 1111 1111 1111"],
      ["IP_ADDRESS", "8.8.8.8"],
      ["EMAIL_ADDRESS", "ada@acme.com"],
    ],
  );
  const byRules = redactPii(text, [], undefined, new PiiVault());
  const bySpans = withActiveVault(new PiiVault(), () => applyPiiSpans(text, spans));
  assert.equal(bySpans, byRules);
  assert.equal(bySpans, "Mail [EMAIL_ADDRESS_1] or [EMAIL_ADDRESS_2], card [CREDIT_CARD_1], from [IP_ADDRESS_1], again [EMAIL_ADDRESS_1].");
  assert.equal(piiPatternSpans("reserved \uFDD0 char ada@acme.com", []), null);
});

test("long text is chunked at whitespace with overlap and a span across a boundary is found once", async () => {
  const filler = "lorem ipsum dolor sit amet ".repeat(80);
  const text = `${filler}Ada Lovelace ${filler}`;
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0]?.start, 0);
  assert.equal(chunks.at(-1)?.end, text.length);
  for (let i = 1; i < chunks.length; i++) {
    const previous = chunks[i - 1]!;
    const current = chunks[i]!;
    assert.ok(current.start < previous.end, "chunks overlap");
    assert.ok(previous.end - current.start <= CHUNK_OVERLAP, "overlap stays within the limit");
    assert.ok(current.end - current.start <= CHUNK_CHARS);
    assert.match(text[previous.end - 1] ?? "", /\s/);
  }
  const emoji = "🎉".repeat(CHUNK_CHARS);
  for (const chunk of chunkText(emoji)) {
    assert.equal(emoji.charCodeAt(chunk.start) >= 0xdc00 && emoji.charCodeAt(chunk.start) <= 0xdfff, false);
  }

  const alias = setup();
  const cut = `${"x".repeat(CHUNK_CHARS - 6)} Ada Lovelace ${filler}`;
  const shared = `${"x".repeat(CHUNK_CHARS - 150)} Ada Lovelace ${"y ".repeat(1_500)}`;
  const found = await detectPiiSpans([cut, shared], { model: alias, principal: systemPrincipal("pii"), timeoutMs: 5_000 });
  for (const sample of [cut, shared]) {
    assert.deepEqual(
      (found.get(sample) ?? []).map((span) => [span.entity, sample.slice(span.start, span.end)]),
      [["PERSON", "Ada Lovelace"]],
    );
  }
  assert.ok(received.filter((input) => input.includes("Ada Lovelace")).length >= 3, "the shared name was seen by two chunks");
});

test("model spans share the vault and its numbering with pattern matches", async () => {
  setup();
  const body = chatBody("Mail ada@acme.com today.", "Ada Lovelace wrote to ada@acme.com and bob@example.com.");
  const patterns = redactJSON(structuredClone(body), [], "", new Set(), new PiiVault()) as JsonMap;
  const vault = new PiiVault();
  const found = new Set<string>();
  const both = (await redactWithPolicy(structuredClone(body), policy({ mode: "restore" }), found, vault)) as JsonMap;
  assert.deepEqual(contentsOf(patterns), ["Mail [EMAIL_ADDRESS_1] today.", "Ada Lovelace wrote to [EMAIL_ADDRESS_1] and [EMAIL_ADDRESS_2]."]);
  assert.deepEqual(contentsOf(both), ["Mail [EMAIL_ADDRESS_1] today.", "[PERSON_1] wrote to [EMAIL_ADDRESS_1] and [EMAIL_ADDRESS_2]."]);
  assert.deepEqual([...found].sort(), ["EMAIL_ADDRESS", "PERSON"]);
  assert.equal(vault.restore(contentsOf(both)[1] ?? ""), "Ada Lovelace wrote to ada@acme.com and bob@example.com.");

  setup();
  const modelOnly = (await redactWithPolicy(structuredClone(body), policy({ detector: "model" }), new Set(), null)) as JsonMap;
  assert.deepEqual(contentsOf(modelOnly), ["Mail [EMAIL_ADDRESS] today.", "[PERSON] wrote to [EMAIL_ADDRESS] and bob@example.com."]);
});

test("secrets always go through patterns first and never reach the redaction model", async () => {
  setup();
  const key = "sk-proj-" + "a1B2c3D4e5F6g7H8i9J0".repeat(2);
  const body = chatBody(`Use ${key} as Ada Lovelace. My password is hunter2-Blue!`);
  const found = new Set<string>();
  const out = (await redactWithPolicy(structuredClone(body), policy({ detector: "model" }), found, new PiiVault())) as JsonMap;
  assert.deepEqual(contentsOf(out), ["Use [SECRET] as [PERSON_1]. My password is [SECRET]"]);
  assert.ok(received.length > 0);
  assert.ok(received.every((text) => !text.includes(key)), "the key never left the gateway");
  assert.ok(found.has("SECRET") && found.has("PERSON"));

  setup();
  const skipped = (await redactWithPolicy(
    structuredClone(body),
    policy({ detector: "model", entities: ["PERSON"] }),
    new Set(),
    null,
  )) as JsonMap;
  assert.deepEqual(contentsOf(skipped), [`Use ${key} as [PERSON]. My password is hunter2-Blue!`]);
});

test("patterns stay the default and never call the model", async () => {
  setup();
  const body = chatBody("Ada Lovelace, ada@acme.com");
  const out = (await redactWithPolicy(structuredClone(body), policy({ detector: "patterns" }), new Set(), null)) as JsonMap;
  assert.deepEqual(contentsOf(out), ["Ada Lovelace, [EMAIL_ADDRESS]"]);
  const legacy = { enabled: true, mode: "mask", output: false, entities: [] } as unknown as PiiPolicy;
  assert.deepEqual(contentsOf(await redactWithPolicy(structuredClone(body), legacy, new Set(), null)), ["Ada Lovelace, [EMAIL_ADDRESS]"]);
  assert.deepEqual(received, []);
  assert.deepEqual(gateway.upstream, []);
});

test("a slow model falls back to patterns with a warning that carries no values, or blocks when configured", async () => {
  const body = chatBody("Ada Lovelace writes from ada@acme.com");
  const logs = captureLogs();
  try {
    setup(1);
    hold = new Promise(() => undefined);
    const out = (await redactWithPolicy(structuredClone(body), policy(), new Set(), null)) as JsonMap;
    assert.deepEqual(contentsOf(out), ["Ada Lovelace writes from [EMAIL_ADDRESS]"]);

    setup(1);
    hold = new Promise(() => undefined);
    await assert.rejects(
      redactWithPolicy(structuredClone(body), policy({ failure: "block" }), new Set(), null),
      (err: unknown) => err instanceof GateError && err.status === 503 && err.code === "pii_detector_unavailable",
    );

    setup();
    gateway.enterprise = { pii_detector: { model: "", timeout_seconds: 5 } };
    const missing = (await redactWithPolicy(structuredClone(body), policy({ detector: "model" }), new Set(), null)) as JsonMap;
    assert.deepEqual(contentsOf(missing), ["Ada Lovelace writes from [EMAIL_ADDRESS]"]);
    assert.deepEqual(received, []);
  } finally {
    logs.restore();
  }
  const warnings = logs.lines.filter((line) => line.includes("pii.detector_failed"));
  assert.equal(warnings.length, 3, logs.lines.join("\n"));
  assert.doesNotMatch(logs.lines.join("\n"), /Ada Lovelace|ada@acme\.com/);
});

test("the concurrency cap queues callers, refuses a full queue, and times out waiting callers", async () => {
  const slots = createSlots(1, 1);
  const release = await slots.acquire(Date.now() + 1_000);
  const waiting = slots.acquire(Date.now() + 1_000);
  await assert.rejects(slots.acquire(Date.now() + 1_000), /queue is full/);
  release();
  (await waiting)();
  const busy = await slots.acquire(Date.now() + 1_000);
  await assert.rejects(slots.acquire(Date.now() + 20), /timed out/);
  busy();
});

test("a gateway request detects with the model, logs the detector call without content, and stores only placeholders", async () => {
  const alias = setup();
  gateway.key = {
    ...gateway.key,
    logContent: true,
    piiPolicy: policy({ mode: "restore" }),
  };
  recordedPrisma.handlers = {
    user: {
      findUnique: ({ where }: { where: { id: string } }) =>
        where.id === gateway.key.userId
          ? { id: where.id, blocked: false, orgId: null, spend: 0, maxBudget: 0, budgetDuration: "", spendResetAt: null, createdAt: new Date(0), logContent: true }
          : null,
    },
  };
  gateway.reply = async (call) => {
    if (call.url.endsWith("/v1/token-classification")) return redactorReply(call);
    return chatReply("Thanks [PERSON_1], I will write to [EMAIL_ADDRESS_1].");
  };
  const { POST } = await import("@/app/api/v1/chat/completions/route");
  const res = await POST(gatewayRequest("/api/v1/chat/completions", chatBody("I am Ada Lovelace, mail ada@acme.com")));
  assert.equal(res.status, 200);
  const answer = (await res.json()) as { choices: { message: { content: string } }[] };
  assert.equal(answer.choices[0]?.message.content, "Thanks Ada Lovelace, I will write to ada@acme.com.");
  const chat = gateway.upstream.find((call) => call.url.endsWith("/chat/completions"));
  assert.ok(JSON.stringify(chat?.body).includes("I am [PERSON_1], mail [EMAIL_ADDRESS_1]"));
  assert.doesNotMatch(JSON.stringify(chat?.body), /Ada Lovelace|ada@acme\.com/);

  const rows = recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
  const detector = rows.filter((row) => row.endpoint === "internal:pii");
  assert.equal(detector.length, 1);
  assert.equal(detector[0]?.model, alias);
  assert.equal(detector[0]?.contentSkip, "system");
  assert.equal(detector[0]?.content, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /Ada Lovelace|ada@acme\.com/);
});

test("the PII model test needs platform settings managers and lists the spans", async () => {
  const alias = setup();
  const session = (permissions: Permission[]): AuthenticatedSession => ({
    error: false,
    sessionId: "",
    user: { id: "u1", username: "ops", email: "ops@example.com", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "MANAGEMENT_KEY",
    ipAddress: null,
    userAgent: null,
  });
  await assert.rejects(runAsPrincipal(session(["settings:read"]), () => testPiiModel({ model: alias, text: "Ada Lovelace" })), /FORBIDDEN/);
  const result = await runAsPrincipal(session(["settings:read", "settings:manage"]), () =>
    testPiiModel({ model: alias, text: "Ich bin Anna Schneider, Hauptstraße 12, 10115 Berlin." }),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.spans.map((span) => span.entity), ["PERSON", "ADDRESS"]);
  const rows = recordedPrisma.called("requestLog", "create").map((call) => (call.args as { data: JsonMap }).data);
  assert.ok(rows.some((row) => row.endpoint === "internal:model_test" && row.contentSkip === "system"));
});

test("LLMHUB_REDACTOR_URL keeps an internal provider and alias in place and disables it once unset", async () => {
  resetGateway();
  await syncRedactorProvider("http://redactor:8080");
  const provider = recordedPrisma.called("providerConnection", "upsert")[0]?.args as { where: { id: string }; create: JsonMap; update: JsonMap };
  assert.equal(provider.where.id, REDACTOR_PROVIDER_ID);
  assert.deepEqual([provider.create.internal, provider.create.baseUrl, provider.update.enabled], [true, "http://redactor:8080", true]);
  const group = recordedPrisma.called("modelGroup", "upsert")[0]?.args as { create: JsonMap; update: JsonMap };
  assert.deepEqual([group.create.alias, group.update], [REDACTOR_ALIAS, {}]);
  const route = recordedPrisma.called("deployment", "upsert")[0]?.args as { create: JsonMap };
  assert.deepEqual([route.create.providerId, route.create.groupAlias, route.create.kind], [REDACTOR_PROVIDER_ID, REDACTOR_ALIAS, "openai_compat"]);
  assert.equal(await featureModel("pii", "redaction"), REDACTOR_ALIAS);

  recordedPrisma.reset();
  await syncRedactorProvider(undefined);
  assert.deepEqual(recordedPrisma.called("providerConnection", "upsert"), []);
  const disabled = recordedPrisma.called("providerConnection", "updateMany")[0]?.args as { where: JsonMap; data: JsonMap };
  assert.deepEqual([disabled.where.id, disabled.data.enabled], [REDACTOR_PROVIDER_ID, false]);

  recordedPrisma.reset({ providerConnection: { upsert: () => Promise.reject(new Error("unique constraint")) } });
  const logs = captureLogs();
  try {
    await ensureRedactorProvider();
  } finally {
    logs.restore();
  }
  assert.ok(logs.lines.some((line) => line.includes("redactor.provider_sync_failed")));
  assert.equal((recordedPrisma.called("providerConnection", "upsert")[0]?.args as { create: JsonMap }).create.baseUrl, "http://redactor.test:8080");
});
