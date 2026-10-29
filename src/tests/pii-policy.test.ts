import {
  callRoute,
  clearOverride,
  errorOf,
  gateway,
  gatewayPostRoutes,
  MODEL,
  MODEL_ROUTES,
  OTHER_POST_ROUTES,
  resetGateway,
  setKeyOverride,
  setOverride,
} from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { GateError } from "@/lib/gateway/errors";
import { applyGuardrails, withTrace } from "@/lib/gateway/access/gate";
import { defaultGuardrails } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds } from "@/lib/gateway/safety/pii";
import { policyLayer, requestEnterprise, resolvePii, resolvePolicies } from "@/lib/settings/enterprise";
import type { Principal } from "@/types/gateway";
import type { GuardrailPolicy, GuardrailRule, PiiPolicy } from "@/types/guardrails";
import type { VirtualKeyView } from "@/types/keys";

const UNSCREENED_ROUTES = new Set(["/api/v1/ocr"]);
const BLOCKED = "request blocked by guardrail policy";
const PII_OFF: PiiPolicy = { enabled: false, mode: "mask", output: false, entities: [], detector: "patterns", failure: "patterns" };

function blockRule(name: string, pattern: string): GuardrailRule {
  return { id: name, name, kind: "denylist", target: "input", action: "block", patterns: [pattern], caseSensitive: false };
}

function piiLayer(entity: string): PiiPolicy {
  return { enabled: true, mode: "mask", output: false, entities: [entity], detector: "patterns", failure: "patterns" };
}

function guardLayer(name: string, pattern = name): GuardrailPolicy {
  return { ...defaultGuardrails(), rules: [blockRule(name, pattern)] };
}

const CODENAMES = guardLayer("Codenames", "Project Falcon");

let keyCount = 0;

function keyPrincipal(
  policy: Omit<PiiPolicy, "detector" | "failure"> | null,
  guardrails: GuardrailPolicy | null = defaultGuardrails(),
): Principal {
  const pii: PiiPolicy | null = policy ? { detector: "patterns", failure: "patterns", ...policy } : null;
  const keyId = `key_${(keyCount += 1)}`;
  if (pii || guardrails) setOverride({ keyId }, { pii, guardrails });
  const key: VirtualKeyView = {
    token_id: keyId,
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
    paused: false,
    paused_until: "",
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
  };
}

const sample = { model: "m", messages: [{ role: "user", content: "mail ada@acme.com from 8.8.8.8" }] };

test("policyLayer treats missing parts as inherited and normalizes stored ones", () => {
  assert.deepEqual(policyLayer({ pii: null, injection: null, secrets: null, rules: null }), {
    pii: null,
    injection: null,
    secrets: null,
    rules: null,
  });
  const layer = policyLayer({
    pii: { mode: "block", entities: ["EMAIL_ADDRESS"] },
    injection: {},
    secrets: null,
    rules: [],
  });
  assert.deepEqual(layer.pii, {
    enabled: true,
    mode: "block",
    output: true,
    entities: ["EMAIL_ADDRESS"],
    detector: "patterns",
    failure: "patterns",
  });
  assert.deepEqual(layer.injection, defaultGuardrails().injection);
  assert.equal(layer.secrets, null);
  assert.deepEqual(layer.rules, []);
  assert.equal(policyLayer({ pii: { mode: "drop" }, injection: null, secrets: null, rules: null }).pii?.mode, "mask");
  assert.deepEqual(
    [
      policyLayer({ pii: { detector: "regex", failure: "ignore" }, injection: null, secrets: null, rules: null }).pii?.detector,
      policyLayer({ pii: { detector: "both", failure: "block" }, injection: null, secrets: null, rules: null }).pii?.failure,
    ],
    ["patterns", "block"],
  );
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

test("saved entity lists from before the internal IP split let internal addresses through", async () => {
  const savedBefore = defaultEntityIds().filter((id) => id !== "PRIVATE_IP_ADDRESS");
  const prompt = { model: "m", messages: [{ role: "user", content: "ssh 192.168.10.4, then dig 8.8.8.8 and fd00::12" }] };
  for (const entities of [[], savedBefore, ["IP_ADDRESS"]]) {
    const { body } = await applyGuardrails(
      structuredClone(prompt),
      keyPrincipal({ enabled: true, mode: "mask", output: false, entities }),
    );
    assert.equal(
      (body.messages as { content: string }[])[0]?.content,
      "ssh 192.168.10.4, then dig [IP_ADDRESS] and fd00::12",
      entities.join(","),
    );
  }
  const { body } = await applyGuardrails(
    structuredClone(prompt),
    keyPrincipal({ enabled: true, mode: "mask", output: false, entities: ["IP_ADDRESS", "PRIVATE_IP_ADDRESS"] }),
  );
  assert.equal(
    (body.messages as { content: string }[])[0]?.content,
    "ssh [PRIVATE_IP_ADDRESS], then dig [IP_ADDRESS] and [PRIVATE_IP_ADDRESS]",
  );
});

test("resolvePolicies takes each part from the most specific level that sets it", async () => {
  resetGateway();
  gateway.enterprise = { pii: piiLayer("CREDIT_CARD"), guardrails: guardLayer("global") };
  const caller = keyPrincipal(null, null);
  const principal: Principal = { ...caller, teamId: "t1", key: { ...caller.key!, project_id: "p1" } };
  const keyId = principal.key!.token_id;
  const resolved = async () => {
    const { pii, guardrails } = await resolvePolicies(principal);
    return [pii.entities[0], guardrails.rules[0]?.name, guardrails.injection.enabled];
  };
  setOverride({ orgId: "org_1" }, { pii: piiLayer("PHONE_NUMBER"), rules: guardLayer("org").rules });
  setOverride({ teamId: "t1" }, { rules: guardLayer("team").rules });
  setOverride({ projectId: "p1" }, { pii: piiLayer("IP_ADDRESS") });
  setOverride({ keyId }, { injection: { enabled: true, action: "block", checks: [] } });
  assert.deepEqual(await resolved(), ["IP_ADDRESS", "team", true]);
  assert.deepEqual((recordedPrisma.called("policyOverride", "findMany").at(-1)?.args as { where: unknown }).where, {
    OR: [{ keyId }, { projectId: "p1" }, { teamId: "t1" }, { orgId: "org_1" }],
  });
  clearOverride({ projectId: "p1" });
  assert.deepEqual(await resolved(), ["PHONE_NUMBER", "team", true]);
  clearOverride({ teamId: "t1" });
  assert.deepEqual(await resolved(), ["PHONE_NUMBER", "org", true]);
  clearOverride({ keyId });
  assert.deepEqual(await resolved(), ["PHONE_NUMBER", "org", false]);
  clearOverride({ orgId: "org_1" });
  assert.deepEqual(await resolved(), ["CREDIT_CARD", "global", false]);
  setOverride({ keyId }, { rules: [] });
  assert.deepEqual(await resolved(), ["CREDIT_CARD", undefined, false]);
});

test("resolvePolicies for a session reads only the organization override", async () => {
  resetGateway();
  gateway.enterprise = { pii: piiLayer("CREDIT_CARD"), guardrails: guardLayer("global") };
  setOverride({ orgId: "o1" }, { rules: guardLayer("org").rules });
  const { guardrails } = await resolvePolicies({
    actor: "u1",
    teamId: "",
    orgId: "o1",
    userId: "u1",
    memberId: "",
    models: [],
    routeLimits: {},
  });
  assert.equal(guardrails.rules[0]?.name, "org");
  assert.deepEqual((recordedPrisma.called("policyOverride", "findMany").at(-1)?.args as { where: unknown }).where, {
    OR: [{ orgId: "o1" }],
  });
});

test("a traced request reads its policies and settings once", async () => {
  resetGateway();
  gateway.enterprise = { pii: piiLayer("CREDIT_CARD"), guardrails: guardLayer("global"), log_content: false };
  const caller = keyPrincipal(null, null);
  const traced = withTrace(caller, "/api/v1/messages");
  const policies = await resolvePolicies(traced);
  assert.equal((await resolvePii(traced)).entities[0], "CREDIT_CARD");
  assert.equal((await requestEnterprise(traced)).log_content, false);
  assert.equal(await resolvePolicies({ ...traced, pool: "subscription" }), policies);
  assert.equal(recordedPrisma.called("setting").length, 1);
  assert.equal(recordedPrisma.called("policyOverride").length, 1);
  gateway.enterprise = { pii: piiLayer("IP_ADDRESS") };
  const untraced = { ...traced, trace: undefined };
  assert.equal((await resolvePii(untraced)).entities[0], "IP_ADDRESS");
  assert.equal((await resolvePii(withTrace(untraced, "/api/v1/messages"))).entities[0], "IP_ADDRESS");
  assert.equal((await resolvePii(traced)).entities[0], "CREDIT_CARD");
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
    setKeyOverride({ guardrails: CODENAMES });
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
  const owner = keyPrincipal(PII_OFF, CODENAMES);
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
          identities: [],
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
      }),
    },
  };
  setOverride({ orgId: "o1" }, { guardrails: CODENAMES });
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
