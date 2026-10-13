import {
  callRoute,
  errorOf,
  gateway,
  gatewayPostRoutes,
  MODEL,
  MODEL_ROUTES,
  OTHER_POST_ROUTES,
  resetGateway,
} from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { GateError } from "@/lib/gateway/errors";
import { applyGuardrails } from "@/lib/gateway/access/gate";
import { defaultGuardrails } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { piiOverride, resolvePolicies } from "@/lib/settings/enterprise";
import type { Principal } from "@/types/gateway";
import type { GuardrailPolicy, GuardrailRule, PiiPolicy } from "@/types/guardrails";
import type { VirtualKeyView } from "@/types/keys";

const UNSCREENED_ROUTES = new Set(["/api/v1/ocr"]);
const BLOCKED = "request blocked by guardrail policy";
const PII_OFF: PiiPolicy = { enabled: false, mode: "mask", output: false, entities: [] };

function blockRule(name: string, pattern: string): GuardrailRule {
  return { id: name, name, kind: "denylist", target: "input", action: "block", patterns: [pattern], caseSensitive: false };
}

function piiLayer(entity: string): PiiPolicy {
  return { enabled: true, mode: "mask", output: false, entities: [entity] };
}

function guardLayer(name: string, pattern = name): GuardrailPolicy {
  return { ...defaultGuardrails(), rules: [blockRule(name, pattern)] };
}

const CODENAMES = guardLayer("Codenames", "Project Falcon");

function keyPrincipal(pii: PiiPolicy): Principal {
  const key: VirtualKeyView = {
    token_id: "key_1",
    key_name: "sk-hub-abcde",
    key_alias: "test",
    user_id: "",
    team_id: "",
    org_id: "org_1",
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
    pii,
    log_content: true,
    created_at: "",
  };
  return {
    actor: key.key_name,
    key,
    teamId: "",
    orgId: "org_1",
    userId: "",
    memberId: "",
    models: [],
    routeLimits: {},
    guardrails: defaultGuardrails(),
  };
}

const sample = { model: "m", messages: [{ role: "user", content: "mail ada@acme.com from 8.8.8.8" }] };

test("piiOverride treats missing values as inherit and normalizes stored policies", () => {
  assert.equal(piiOverride(null), null);
  assert.equal(piiOverride(undefined), null);
  assert.equal(piiOverride([]), null);
  assert.deepEqual(piiOverride({ mode: "block", entities: ["EMAIL_ADDRESS"] }), {
    enabled: true,
    mode: "block",
    output: true,
    entities: ["EMAIL_ADDRESS"],
  });
  assert.equal(piiOverride({ mode: "drop" })?.mode, "mask");
});

test("a key override masks only its own entities and returns them for output redaction", async () => {
  const { body, output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: true, mode: "mask", output: true, entities: ["IP_ADDRESS"] }),
  );
  assert.equal(JSON.stringify(body).includes("ada@acme.com"), true);
  assert.equal(JSON.stringify(body).includes("8.8.8.8"), false);
  assert.deepEqual(output?.pii, ["IP_ADDRESS"]);
});

test("a key override in block mode rejects matching prompts", async () => {
  await assert.rejects(
    applyGuardrails(
      structuredClone(sample),
      keyPrincipal({ enabled: true, mode: "block", output: true, entities: ["EMAIL_ADDRESS"] }),
    ),
    (err: unknown) => err instanceof GateError && err.status === 400 && err.code === "pii_blocked",
  );
  const clean = await applyGuardrails(
    { model: "m", messages: [{ role: "user", content: "hello" }] },
    keyPrincipal({ enabled: true, mode: "block", output: false, entities: ["EMAIL_ADDRESS"] }),
  );
  assert.equal(clean.output, null);
});

test("a disabled key override passes prompts through and skips output redaction", async () => {
  const { body, output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: false, mode: "block", output: true, entities: [] }),
  );
  assert.deepEqual(body, sample);
  assert.equal(output, null);
});

test("an override without entities uses the default set", async () => {
  const { output } = await applyGuardrails(
    structuredClone(sample),
    keyPrincipal({ enabled: true, mode: "mask", output: true, entities: [] }),
  );
  assert.deepEqual(output?.pii, defaultEntityIds());
});

test("resolvePolicies prefers the key, then the project, then the organization, then the global policy", async () => {
  resetGateway();
  gateway.enterprise = { pii: piiLayer("CREDIT_CARD"), guardrails: guardLayer("global") };
  const project = { piiPolicy: piiLayer("IP_ADDRESS") as unknown, guardrailPolicy: guardLayer("project") as unknown };
  const org = { piiPolicy: piiLayer("PHONE_NUMBER") as unknown, guardrailPolicy: guardLayer("org") as unknown };
  recordedPrisma.handlers = {
    project: { findUnique: () => project },
    organization: { findUnique: () => org },
  };
  const resolved = async (pii: PiiPolicy | null, guardrails: GuardrailPolicy | null) => {
    const caller = keyPrincipal(PII_OFF);
    const { pii: chosenPii, guardrails: chosenGuardrails } = await resolvePolicies({
      ...caller,
      key: { ...caller.key!, pii, project_id: "p1" },
      guardrails,
    });
    return [chosenPii.entities[0], chosenGuardrails.rules[0]?.name];
  };
  assert.deepEqual(await resolved(piiLayer("EMAIL_ADDRESS"), guardLayer("key")), ["EMAIL_ADDRESS", "key"]);
  assert.deepEqual(await resolved(piiLayer("EMAIL_ADDRESS"), null), ["EMAIL_ADDRESS", "project"]);
  assert.deepEqual(await resolved(null, null), ["IP_ADDRESS", "project"]);
  project.piiPolicy = null;
  project.guardrailPolicy = null;
  assert.deepEqual(await resolved(null, guardLayer("key")), ["PHONE_NUMBER", "key"]);
  assert.deepEqual(await resolved(null, null), ["PHONE_NUMBER", "org"]);
  org.piiPolicy = null;
  org.guardrailPolicy = null;
  assert.deepEqual(await resolved(null, null), ["CREDIT_CARD", "global"]);
});

test("the guardrail sweep covers every gateway POST route", async () => {
  assert.deepEqual(
    [...MODEL_ROUTES.map((route) => route.path), ...OTHER_POST_ROUTES].sort(),
    await gatewayPostRoutes(),
  );
});

test("every gateway model route applies the caller's guardrails before contacting a provider", async () => {
  for (const route of MODEL_ROUTES.filter((candidate) => !UNSCREENED_ROUTES.has(candidate.path))) {
    resetGateway();
    gateway.key = { ...gateway.key, guardrailPolicy: CODENAMES };
    const blocked = await errorOf(await callRoute(route, route.body("status of Project Falcon")));
    assert.equal(blocked.status, 400, route.path);
    assert.equal(blocked.message, BLOCKED, route.path);
    assert.deepEqual(gateway.upstream, [], route.path);
    resetGateway();
    const open = await callRoute(route, route.body("status of Project Falcon"));
    assert.doesNotMatch(await open.text(), /guardrail/, route.path);
  }
});

test("batch lines apply the batch owner's guardrails", async () => {
  const { runBatchLine } = await import("@/lib/gateway/endpoints/batches");
  resetGateway();
  const owner = { ...keyPrincipal(PII_OFF), guardrails: CODENAMES };
  const line = await runBatchLine(owner, "/v1/chat/completions", {
    model: MODEL,
    messages: [{ role: "user", content: "status of Project Falcon" }],
  });
  assert.deepEqual(line.ok ? null : [line.status, line.error.code], [400, "guardrail_blocked"]);
  assert.deepEqual(gateway.upstream, []);
});

test("the playground applies the signed-in user's organization guardrails", async () => {
  const { POST } = await import("@/app/internal-api/playground/chat/route");
  resetGateway();
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("b".repeat(64)) } });
  recordedPrisma.handlers = {
    session: {
      findUnique: () => ({
        id: "s1",
        expiresAt: new Date(Date.now() + 3_600_000),
        lastActive: new Date(),
        secondFactor: "TOTP",
        ipAddress: null,
        userAgent: null,
        user: {
          id: "member-1",
          username: "member",
          blocked: false,
          isOwner: false,
          orgId: "o1",
          roleId: "r1",
          role: { id: "r1", templateKey: null, name: "Member", permissions: ["playground:use"] },
        },
      }),
    },
    organization: {
      findUnique: () => ({
        id: "o1",
        spend: 0,
        maxBudget: 0,
        budgetDuration: "",
        spendResetAt: null,
        createdAt: new Date(0),
        piiPolicy: null,
        guardrailPolicy: CODENAMES,
      }),
    },
  };
  const res = await POST(
    new Request("http://hub.local/internal-api/playground/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "status of Project Falcon" }] }),
    }),
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "GUARDRAIL_BLOCKED");
  assert.deepEqual(gateway.upstream, []);
});
