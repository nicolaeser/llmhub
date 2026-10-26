import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { Principal, RequestTrace } from "@/types/gateway";
import type { VirtualKeyView } from "@/types/keys";
import type { Deployment } from "@/types/routing";

type Row = Record<string, unknown>;
type Call = { model: string; method: string; args: { where?: Row; data?: Row; create?: Row; select?: Row } };

const calls: Call[] = [];
const orgs = new Map<string, Row>();
let enterprise: Row = {};

function fakeModel(model: string) {
  const record = (method: string, args: Call["args"]) => calls.push({ model, method, args });
  return {
    findUnique: async (args: Call["args"]) => {
      record("findUnique", args);
      if (model === "setting") {
        return args.where?.key === "enterprise" ? { key: "enterprise", value: JSON.stringify(enterprise) } : null;
      }
      if (model === "organization") return orgs.get(String(args.where?.id)) ?? null;
      return null;
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
      if (model === "$transaction") return (ops: Promise<unknown>[]) => Promise.all(ops);
      const fake = models.get(model) ?? fakeModel(model);
      models.set(model, fake);
      return fake;
    },
  },
);
delete process.env.REDIS_URL;

beforeEach(() => {
  calls.length = 0;
  orgs.clear();
  enterprise = {};
});

let orgSeq = 0;
function freshOrg(labelKeys: string[]): string {
  orgSeq += 1;
  const id = `org_labels_${orgSeq}`;
  orgs.set(id, { id, labelKeys, piiPolicy: null, guardrailPolicy: null });
  return id;
}

function keyView(): VirtualKeyView {
  return {
    token_id: "key_labels",
    key_name: "sk-hub-labels",
    key_alias: "labels",
    user_id: "",
    team_id: "",
    org_id: "",
    project_id: "proj_1",
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

function principal(orgId: string, over: Partial<Principal> = {}): Principal {
  return {
    actor: "sk-hub-labels",
    key: keyView(),
    teamId: "team_1",
    orgId,
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    trace: trace(),
    ...over,
  };
}

const deployment: Deployment = {
  id: "dep_labels",
  kind: "openai",
  base_url: "https://upstream.example.invalid/v1",
  model: "gpt-4o",
  weight: 1,
  cost_input_per_1k: 1,
  cost_output_per_1k: 2,
  provider_id: "",
};

function labelUpserts(): Row[] {
  return calls
    .filter((call) => call.model === "usageLabelDaily" && call.method === "upsert")
    .map((call) => call.args.create ?? {});
}

function storedLabels(): unknown {
  const create = calls.find((call) => call.model === "requestLog" && call.method === "create");
  assert.ok(create);
  return create.args.data?.labels;
}

test("label keys are lowercased, dashes become underscores, and odd keys are refused", async () => {
  const { labelKey, labelKeyList, cleanLabelKeys, MAX_LABEL_KEYS } = await import("@/lib/usage/labels");
  assert.equal(labelKey(" Cost-Center "), "cost_center");
  assert.equal(labelKey("env"), "env");
  assert.equal(labelKey("1env"), null);
  assert.equal(labelKey("cost center"), null);
  assert.equal(labelKey("kunde.name"), null);
  assert.equal(labelKey("a".repeat(41)), null);
  assert.deepEqual(labelKeyList(["Env", "env", "feature", "bad key"]), { keys: ["env", "feature"], invalid: ["bad key"] });
  assert.throws(() => cleanLabelKeys(["ok", "not ok"]), /LABEL_KEY_INVALID/);
  assert.throws(
    () => cleanLabelKeys(Array.from({ length: MAX_LABEL_KEYS + 1 }, (_, index) => `key_${index}`)),
    /LABEL_KEYS_LIMIT/,
  );
});

test("label values are trimmed, cleared of control characters, and cut at the length limit", async () => {
  const { labelValue, MAX_LABEL_VALUE_LENGTH, parseLabelFilter } = await import("@/lib/usage/labels");
  assert.equal(labelValue("  search\n  beta\t"), "search beta");
  assert.equal(labelValue(4711), "4711");
  assert.equal(labelValue(""), null);
  assert.equal(labelValue({ nested: true }), null);
  assert.equal(labelValue(Number.NaN), null);
  const long = labelValue("🙂".repeat(MAX_LABEL_VALUE_LENGTH + 20));
  assert.equal([...(long ?? "")].length, MAX_LABEL_VALUE_LENGTH);
  assert.deepEqual(parseLabelFilter("Cost-Center:a:b"), { key: "cost_center", value: "a:b" });
  assert.equal(parseLabelFilter("cost_center"), null);
  assert.equal(parseLabelFilter(":4711"), null);
});

test("headers carry labels per key or bundled, percent-decoded, with the per-key header winning", async () => {
  const { headerLabels } = await import("@/lib/gateway/billing/request-labels");
  const headers = new Headers({
    "X-LLMHub-Label-Cost-Center": "4711",
    "x-llmhub-label-kunde": "M%C3%BCller%20GmbH",
    "x-llmhub-labels": "env=prod, cost_center=9999, broken, feature=a%2Cb, bad%=x%zz",
    "x-llmhub-mcp": "off",
  });
  assert.deepEqual(headerLabels(headers), {
    cost_center: "4711",
    kunde: "Müller GmbH",
    env: "prod",
    feature: "a,b",
  });
});

test("body labels come from metadata and key:value tags, plain tags stay tags only", async () => {
  const { bodyLabels, mergeLabels, MAX_LABEL_CANDIDATES } = await import("@/lib/gateway/billing/request-labels");
  const body = {
    metadata: { feature: "search", user_id: "end-user", nested: { no: 1 } },
    tags: ["team-a", "env:prod", "feature=ignored", "kunde:ACME:EU", 7],
  };
  assert.deepEqual(bodyLabels(body), {
    feature: "search",
    user_id: "end-user",
    env: "prod",
    kunde: "ACME:EU",
  });
  assert.deepEqual(mergeLabels({ env: "header" }, bodyLabels(body)).env, "header");
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`key_${index}`, "v"]));
  assert.equal(Object.keys(bodyLabels({ metadata: many })).length, MAX_LABEL_CANDIDATES);
});

test("only allowed keys are picked, sorted, and capped per request", async () => {
  const { pickLabels } = await import("@/lib/gateway/billing/request-labels");
  const { MAX_REQUEST_LABELS } = await import("@/lib/usage/labels");
  const candidates = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${String(index).padStart(2, "0")}`, "v"]));
  const allowed = new Set(Object.keys(candidates).filter((key) => key !== "k00"));
  const picked = pickLabels({ ...candidates, other: "x" }, allowed);
  assert.equal(picked.length, MAX_REQUEST_LABELS);
  assert.equal(picked[0]?.key, "k01");
  assert.ok(picked.every((label, index, list) => index === 0 || list[index - 1]!.key < label.key));
});

test("traces inherit label candidates into sub-calls and applyGuardrails adds the client body after headers", async () => {
  const { applyGuardrails, withTrace } = await import("@/lib/gateway/access/gate");
  const { headerLabels } = await import("@/lib/gateway/billing/request-labels");
  const orgId = freshOrg([]);
  const traced = principal(orgId, {
    trace: trace({ labels: headerLabels(new Headers({ "x-llmhub-label-env": "staging" })) }),
  });
  await applyGuardrails({ model: "gpt", messages: [], metadata: { env: "prod", feature: "chat" } }, traced);
  assert.deepEqual(traced.trace?.labels, { env: "staging", feature: "chat" });
  assert.deepEqual(withTrace(traced, "/v1/embeddings").trace?.labels, { env: "staging", feature: "chat" });
  assert.equal(withTrace({ ...traced, trace: undefined }, "/v1/embeddings").trace?.labels, undefined);
});

test("recordUsage books allowed labels into the label rollup and the request log", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  enterprise = { label_keys: ["env"] };
  const orgId = freshOrg(["cost_center"]);
  const traced = principal(orgId, { trace: trace({ labels: { cost_center: "4711" } }) });
  const cost = await recordUsage({
    principal: traced,
    model: "gpt",
    deployment,
    usage: { prompt_tokens: 1000, completion_tokens: 500 },
    status: 200,
    outcome: "ok",
    latencyMs: 30,
    request: { model: "gpt", metadata: { env: "prod", secret_project: "x" }, tags: ["feature:search"] },
  });

  const upserts = labelUpserts();
  assert.deepEqual(
    upserts.map((row) => [row.label, row.value]),
    [
      ["cost_center", "4711"],
      ["env", "prod"],
    ],
  );
  for (const row of upserts) {
    assert.equal(row.orgId, orgId);
    assert.equal(row.keyId, "key_labels");
    assert.equal(row.projectId, "proj_1");
    assert.equal(row.model, "gpt");
    assert.equal(row.requests, 1);
    assert.equal(row.cost, cost);
    assert.equal(row.promptTokens, 1000);
  }
  assert.deepEqual(storedLabels(), ["cost_center:4711", "env:prod"]);
  const order = calls.filter((call) => call.method === "upsert" || call.method === "updateMany").map((call) => call.model);
  assert.ok(order.indexOf("usageLabelDaily") < order.indexOf("organization"), "label rows before the shared holders");
});

test("label values are masked with the effective PII policy before they are stored", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  enterprise = {
    label_keys: ["owner"],
    pii: { enabled: true, mode: "mask", output: true, entities: ["EMAIL_ADDRESS"], detector: "patterns", failure: "patterns" },
  };
  const orgId = freshOrg([]);
  await recordUsage({
    principal: principal(orgId),
    model: "gpt",
    deployment,
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    status: 200,
    outcome: "ok",
    latencyMs: 5,
    request: { metadata: { owner: "ada@acme.com" } },
  });
  const [row] = labelUpserts();
  assert.ok(row);
  assert.doesNotMatch(String(row.value), /ada@acme\.com/);
  assert.match(String(row.value), /EMAIL_ADDRESS/);
  assert.deepEqual(storedLabels(), [`owner:${row.value}`]);
});

test("unlabelled requests read no allowlist, and company keys are cached until forgotten", async () => {
  const { recordUsage } = await import("@/lib/gateway/billing/billing");
  const { forgetCompanyLabelKeys } = await import("@/lib/gateway/billing/label-keys");
  const orgId = freshOrg(["feature"]);
  const call = (request: unknown) =>
    recordUsage({
      principal: principal(orgId),
      model: "gpt",
      deployment,
      usage: { prompt_tokens: 1, completion_tokens: 1 },
      status: 200,
      outcome: "ok",
      latencyMs: 1,
      request,
    });
  const labelReads = () =>
    calls.filter((call) => call.model === "organization" && call.method === "findUnique" && call.args.select?.labelKeys);

  await call({ model: "gpt" });
  assert.equal(labelReads().length, 0);
  assert.equal(labelUpserts().length, 0);

  await call({ metadata: { feature: "a" } });
  await call({ metadata: { feature: "b" } });
  assert.equal(labelReads().length, 1);
  assert.deepEqual(labelUpserts().map((row) => row.value), ["a", "b"]);

  orgs.set(orgId, { ...orgs.get(orgId), labelKeys: [] });
  forgetCompanyLabelKeys(orgId);
  calls.length = 0;
  await call({ metadata: { feature: "c" } });
  assert.equal(labelReads().length, 1);
  assert.equal(labelUpserts().length, 0);
});

test("system callers never carry labels", async () => {
  const { requestLabels } = await import("@/lib/gateway/billing/label-keys");
  enterprise = { label_keys: ["env"] };
  const labels = await requestLabels(principal("", { system: "pii", key: undefined }), { metadata: { env: "prod" } });
  assert.deepEqual(labels, []);
  assert.equal(calls.length, 0);
});
