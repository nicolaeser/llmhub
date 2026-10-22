import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { GateError } from "@/lib/gateway/errors";
import type { Principal, RequestTrace } from "@/types/gateway";
import type { VirtualKeyView } from "@/types/keys";
import type { Deployment } from "@/types/routing";
import type { PiiPolicy } from "@/types/guardrails";
import type * as Billing from "@/lib/gateway/billing/billing";

type Row = Record<string, unknown>;
type Call = { model: string; method: string; args: { where?: Row; data?: Row } };

const calls: Call[] = [];
const tables = new Map<string, Map<string, Row>>();
const upsertFailures: Error[] = [];
const transactionOptions: unknown[] = [];
let enterprise: Row = {};

function table(model: string): Map<string, Row> {
  const rows = tables.get(model) ?? new Map<string, Row>();
  tables.set(model, rows);
  return rows;
}

function fakeModel(model: string) {
  const record = (method: string, args: Call["args"]) => calls.push({ model, method, args });
  return {
    findUnique: async (args: Call["args"]) => {
      record("findUnique", args);
      if (model === "setting") {
        return args.where?.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null;
      }
      return table(model).get(String(args.where?.id)) ?? null;
    },
    findMany: async (args: Call["args"]) => {
      record("findMany", args);
      return [];
    },
    updateMany: async (args: Call["args"]) => {
      record("updateMany", args);
      return { count: 1 };
    },
    upsert: async (args: Call["args"]) => {
      record("upsert", args);
      const failure = upsertFailures.shift();
      if (failure) throw failure;
      return {};
    },
    create: async (args: Call["args"]) => {
      record("create", args);
      return { id: `${model}_1`, createdAt: new Date(), ...args.data };
    },
  };
}

const models = new Map<string, ReturnType<typeof fakeModel>>();

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) => {
      if (model === "$transaction") {
        return (ops: Promise<unknown>[], options?: unknown) => {
          transactionOptions.push(options);
          return Promise.all(ops);
        };
      }
      const fake = models.get(model) ?? fakeModel(model);
      models.set(model, fake);
      return fake;
    },
  },
);
delete process.env.REDIS_URL;

beforeEach(() => {
  calls.length = 0;
  tables.clear();
  upsertFailures.length = 0;
  transactionOptions.length = 0;
  enterprise = {};
});

function keyView(over: Partial<VirtualKeyView> = {}): VirtualKeyView {
  return {
    token_id: "key_1",
    key_name: "sk-hub-abcde",
    key_alias: "billing",
    user_id: "",
    team_id: "",
    org_id: "",
    project_id: "",
    member_id: "",
    models: [],
    templates: [],
    max_budget: 0,
    spend: 0,
    rpm_limit: 0,
    tpm_limit: 0,
    max_request_cost: 0,
    budget_duration: "",
    expires: "",
    allowed_ips: [],
    allowed_endpoints: [],
    access_windows: [],
    access_time_zone: "UTC",
    blocked: false,
    pii: null,
    log_content: true,
    created_at: "",
    ...over,
  };
}

function principal(over: Partial<Principal> = {}): Principal {
  return {
    actor: "sk-hub-abcde",
    teamId: "",
    orgId: "",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    ...over,
  };
}

function trace(over: Partial<RequestTrace> = {}): RequestTrace {
  return {
    endpoint: "/v1/chat/completions",
    piiMode: "",
    piiInput: new Set(),
    piiOutput: new Set(),
    guardInput: new Set(),
    guardOutput: new Set(),
    guardBlocked: false,
    ...over,
  };
}

const deployment: Deployment = {
  id: "dep_1",
  kind: "openai",
  base_url: "https://upstream.example.invalid/v1",
  model: "gpt-4o-2024-08-06",
  weight: 1,
  cost_input_per_1k: 1,
  cost_output_per_1k: 2,
  provider_id: "",
};

const policy = (over: Partial<PiiPolicy>): PiiPolicy => ({
  enabled: true,
  mode: "mask",
  output: true,
  entities: ["EMAIL_ADDRESS"],
  ...over,
});

type StoredLog = Row & {
  content?: { create: { request?: unknown; response?: unknown; truncated: boolean } };
};

function storedLog(): StoredLog {
  const writes = calls.filter((call) => call.model === "requestLog" && call.method === "create");
  assert.equal(writes.length, 1);
  return writes[0].args.data as StoredLog;
}

async function logFor(who: Principal): Promise<StoredLog> {
  const { writeRequestLog } = await import("@/lib/gateway/request-logs/request-log");
  calls.length = 0;
  await writeRequestLog({
    principal: who,
    model: "gpt",
    deployment,
    status: 200,
    outcome: "ok",
    latencyMs: 5,
    tag: "",
    promptTokens: 1,
    completionTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    request: { messages: [{ role: "user", content: "write to ada@acme.com" }] },
    response: { choices: [{ message: { role: "assistant", content: "sent to ada@acme.com" } }] },
  });
  return storedLog();
}

function rejectsWith(status: number, code: string, message?: string) {
  return (err: unknown) => {
    assert.ok(err instanceof GateError, String(err));
    assert.equal(err.status, status);
    assert.equal(err.code, code);
    if (message !== undefined) assert.equal(err.message, message);
    return true;
  };
}

test("recordUsage hands every request to the request log with tokens, cost, and content", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  const request = { model: "gpt", messages: [{ role: "user", content: "hello" }] };
  const response = { choices: [{ message: { role: "assistant", content: "hi there" } }] };
  const cost = await recordUsage({
    principal: principal({ key: keyView({ project_id: "proj_1" }), teamId: "team_1", orgId: "org_1" }),
    model: "gpt",
    deployment,
    usage: { prompt_tokens: 1000, completion_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 },
    status: 502,
    outcome: "upstream_error",
    latencyMs: 40,
    stream: true,
    request,
    response,
    error: new Error("upstream said no"),
  });

  const log = storedLog();
  assert.ok(cost > 0);
  assert.equal(log.cost, cost);
  assert.equal(log.promptTokens, 1000);
  assert.equal(log.completionTokens, 500);
  assert.equal(log.cacheReadTokens, 200);
  assert.equal(log.cacheWriteTokens, 100);
  assert.equal(log.stream, true);
  assert.equal(log.status, 502);
  assert.equal(log.outcome, "upstream_error");
  assert.equal(log.error, "upstream said no");
  assert.deepEqual(log.content?.create, { request, response, truncated: false });
});

function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function meteringCall(): Parameters<typeof Billing.recordUsage>[0] {
  return {
    principal: principal({ key: keyView(), teamId: "team_1", orgId: "org_1" }),
    model: "gpt",
    deployment,
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    status: 200,
    outcome: "ok",
    latencyMs: 40,
  };
}

function usageUpserts(): number {
  return calls.filter((call) => call.model === "usageDaily" && call.method === "upsert").length;
}

test("a metering transaction that expired under load is retried and books the request once", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  upsertFailures.push(prismaError("P2028", "Transaction API error: Unable to start a transaction in the given time."));
  const cost = await recordUsage(meteringCall());
  assert.ok(cost > 0);
  assert.equal(usageUpserts(), 2);
  assert.equal(storedLog().status, 200);
  const [options] = transactionOptions as { maxWait: number; timeout: number }[];
  assert.ok(options!.maxWait > 2_000);
  assert.ok(options!.timeout > 5_000);
});

test("metering gives up after repeated expiries and never retries other failures", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  for (let i = 0; i < 5; i++) upsertFailures.push(prismaError("P2028", "Transaction already closed"));
  await assert.rejects(recordUsage(meteringCall()), { code: "P2028" });
  assert.equal(usageUpserts(), 3);
  calls.length = 0;
  upsertFailures.length = 0;
  upsertFailures.push(prismaError("P2002", "Unique constraint failed"));
  await assert.rejects(recordUsage(meteringCall()), { code: "P2002" });
  assert.equal(usageUpserts(), 1);
  assert.equal(calls.filter((call) => call.model === "requestLog").length, 0);
});

test("requestLog.create stores tenancy, routing, PII markers, and nested content", async () => {
  table("member").set("mem_9", { id: "mem_9", logContent: true });
  const scanned = { messages: [{ role: "user", content: "mail [EMAIL_ADDRESS]" }] };
  const log = await logFor(
    principal({
      key: keyView({ token_id: "key_9", project_id: "proj_9" }),
      teamId: "team_9",
      orgId: "org_9",
      memberId: "mem_9",
      trace: trace({ request: scanned, piiMode: "mask", piiInput: new Set(["EMAIL_ADDRESS"]) }),
    }),
  );

  assert.equal(log.keyId, "key_9");
  assert.equal(log.orgId, "org_9");
  assert.equal(log.teamId, "team_9");
  assert.equal(log.projectId, "proj_9");
  assert.equal(log.memberId, "mem_9");
  assert.equal(log.endpoint, "/v1/chat/completions");
  assert.equal(log.deploymentId, "dep_1");
  assert.equal(log.provider, "openai");
  assert.equal(log.upstreamModel, "gpt-4o-2024-08-06");
  assert.equal(log.piiMode, "mask");
  assert.deepEqual(log.piiInput, ["EMAIL_ADDRESS"]);
  assert.deepEqual(log.piiOutput, ["EMAIL_ADDRESS"]);
  assert.equal(log.contentSkip, "");
  assert.deepEqual(log.content?.create, {
    request: scanned,
    response: { choices: [{ message: { role: "assistant", content: "sent to [EMAIL_ADDRESS]" } }] },
    truncated: false,
  });
});

test("content logging honours the gateway, key, member, and user switches", async () => {
  table("member").set("mem_off", { id: "mem_off", logContent: false });
  table("user").set("user_off", { id: "user_off", logContent: false });
  table("user").set("user_on", { id: "user_on", logContent: true });

  const allowed = await logFor(principal({ userId: "user_on" }));
  assert.equal(allowed.contentSkip, "");
  assert.ok(allowed.content?.create.request);
  assert.ok(allowed.content?.create.response);

  const skipped = async (who: Principal) => {
    const log = await logFor(who);
    assert.equal(log.content, undefined);
    assert.equal(log.promptTokens, 1);
    return log.contentSkip;
  };
  assert.equal(await skipped(principal({ key: keyView({ log_content: false }) })), "key");
  assert.equal(await skipped(principal({ key: keyView(), memberId: "mem_off" })), "member");
  assert.equal(await skipped(principal({ userId: "user_off" })), "user");
  enterprise = { log_content: false };
  assert.equal(await skipped(principal({ userId: "user_on" })), "gateway");
  assert.equal(await skipped(principal({ key: keyView() })), "gateway");
});

test("stored log content is masked with the effective PII policy, including overrides", async () => {
  const masked = (log: StoredLog) => JSON.stringify(log.content?.create);
  enterprise = { pii: { enabled: false } };
  table("project").set("proj_pii", { id: "proj_pii", piiPolicy: policy({}), guardrailPolicy: null });
  table("organization").set("org_pii", { id: "org_pii", piiPolicy: policy({}), guardrailPolicy: null });
  table("organization").set("org_plain", { id: "org_plain", piiPolicy: null, guardrailPolicy: null });

  const plain = masked(await logFor(principal({ orgId: "org_plain" })));
  assert.ok(plain.includes("ada@acme.com"));

  for (const who of [
    principal({ key: keyView({ project_id: "proj_pii" }), orgId: "org_plain" }),
    principal({ orgId: "org_pii" }),
    principal({ key: keyView({ pii: policy({}) }) }),
  ]) {
    const content = masked(await logFor(who));
    assert.equal(content.includes("ada@acme.com"), false, content);
    assert.ok(content.includes("[EMAIL_ADDRESS]"), content);
  }

  enterprise = {};
  const keyOff = masked(await logFor(principal({ key: keyView({ pii: policy({ enabled: false }) }), orgId: "org_pii" })));
  assert.ok(keyOff.includes("ada@acme.com"));
});

test("restore mode records which placeholders went out and where the reply used them, never the values", async () => {
  const { writeRequestLog } = await import("@/lib/gateway/request-logs/request-log");
  const { PiiVault, bindPiiVault } = await import("@/lib/gateway/safety/pii-vault");
  const write = async (who: Principal, response: unknown) => {
    calls.length = 0;
    await writeRequestLog({
      principal: who,
      model: "gpt",
      deployment,
      status: 200,
      outcome: "ok",
      latencyMs: 5,
      tag: "",
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      response,
    });
    return storedLog();
  };
  const restoring = (logContent: boolean) => {
    const traced = trace({
      piiMode: "restore",
      piiInput: new Set(["EMAIL_ADDRESS", "IP_ADDRESS"]),
      request: { messages: [{ role: "user", content: "mail [EMAIL_ADDRESS_1] from [IP_ADDRESS_1]" }] },
    });
    const vault = new PiiVault();
    vault.placeholder("EMAIL_ADDRESS", "ada@acme.com");
    vault.placeholder("IP_ADDRESS", "203.0.113.9");
    bindPiiVault(traced, vault);
    return principal({ key: keyView({ log_content: logContent }), trace: traced });
  };
  const reply = {
    choices: [
      {
        message: {
          role: "assistant",
          content: "Mailing [EMAIL_ADDRESS_1]",
          tool_calls: [{ id: "t1", type: "function", function: { name: "ping", arguments: '{"host":"[IP_ADDRESS_1]"}' } }],
        },
      },
    ],
  };
  const summary = { placeholders: ["[EMAIL_ADDRESS_1]", "[IP_ADDRESS_1]"], text: ["[EMAIL_ADDRESS_1]"], tools: ["[IP_ADDRESS_1]"] };

  const logged = await write(restoring(true), reply);
  assert.deepEqual(logged.piiRestore, summary);
  assert.equal(logged.piiMode, "restore");
  const stored = JSON.stringify(logged);
  assert.equal(stored.includes("ada@acme.com"), false);
  assert.equal(stored.includes("203.0.113.9"), false);
  assert.ok(stored.includes("[IP_ADDRESS_1]"));

  const withoutContent = await write(restoring(false), reply);
  assert.equal(withoutContent.content, undefined);
  assert.deepEqual(withoutContent.piiRestore, summary);

  const masked = await write(principal({ trace: trace({ piiMode: "mask" }) }), reply);
  assert.equal("piiRestore" in masked, false);
});

test("assertBudget is async and resolves to the remaining budget", async () => {
  const { assertBudget } = await import("@/lib/gateway/billing/billing");
  table("virtualKey").set("key_1", { id: "key_1", spend: 4, maxBudget: 10, budgetDuration: "", spendResetAt: null, createdAt: new Date() });
  const pending = assertBudget(principal({ key: keyView() }));
  assert.ok(pending instanceof Promise);
  assert.deepEqual(await pending, { limit: 6, budget: "key" });

  table("virtualKey").set("key_1", { id: "key_1", spend: 10, maxBudget: 10, budgetDuration: "", spendResetAt: null, createdAt: new Date() });
  await assert.rejects(assertBudget(principal({ key: keyView() })), rejectsWith(429, "budget_exceeded", "key budget exceeded"));
});

test("assertRate counts in the shared rate window that recorded usage also feeds", async () => {
  const { assertRate } = await import("@/lib/gateway/billing/billing");
  const { incrementRateWindow, resetRateLimitMemory } = await import("@/lib/rate-limit/shared");
  resetRateLimitMemory();
  const limited = principal({ key: keyView({ token_id: "key_rpm", rpm_limit: 2 }) });
  await assertRate(limited);
  await assertRate(limited);
  await assert.rejects(assertRate(limited), rejectsWith(429, "rate_limit_exceeded", "rpm exceeded"));
  assert.equal((await incrementRateWindow("key_rpm", 0, 0)).rpm, 3);

  resetRateLimitMemory();
  await assertRate(limited);

  await incrementRateWindow("key_tpm", 0, 100);
  await assert.rejects(
    assertRate(principal({ key: keyView({ token_id: "key_tpm", tpm_limit: 100 }) })),
    rejectsWith(429, "rate_limit_exceeded", "tpm exceeded"),
  );
});
