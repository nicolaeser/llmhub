import assert from "node:assert/strict";
import test from "node:test";
import { transition } from "@/lib/integrations/lifecycle";
import { authorizeTool, visibleTools, type CallableTool } from "@/lib/integrations/mcp-protocol";
import { evaluatePolicy, stripFields } from "@/lib/integrations/policy";
import { canInstantiate, mergePolicyLayers, publicCredential, publicationBlock } from "@/lib/integrations/scope";
import type { PolicyContext, PolicyRule } from "@/types/integrations";

const now = new Date("2026-06-01T12:00:00.000Z");

function ctx(over: Partial<PolicyContext> = {}): PolicyContext {
  return {
    tool: "find_customers",
    operation: "find_customers",
    sideEffect: "read",
    resource: "/customers",
    parameters: {},
    environment: "production",
    now,
    ...over,
  };
}

const rules: PolicyRule[] = [
  { effect: "deny", effects: ["destructive"] },
  { effect: "deny", effects: ["sensitive"] },
  { effect: "allow", effects: ["read"], denyFields: ["secret"], quotaRpm: 30 },
  { effect: "allow", effects: ["write"], operations: ["add_note"] },
];

test("policy denies by default and lets an explicit deny win", () => {
  assert.equal(evaluatePolicy([], ctx()).decision, "deny");
  assert.equal(evaluatePolicy([], ctx()).reason, "deny_by_default");
  assert.equal(evaluatePolicy(rules, ctx({ sideEffect: "destructive", operation: "delete_record" })).decision, "deny");
  assert.equal(evaluatePolicy(rules, ctx({ sideEffect: "destructive", operation: "delete_record" })).matched, "deny");
  const write = evaluatePolicy(rules, ctx({ sideEffect: "write", operation: "add_note", tool: "add_note" }));
  assert.equal(write.decision, "allow");
  const read = evaluatePolicy(rules, ctx());
  assert.equal(read.decision, "allow");
  assert.deepEqual(read.denyFields, ["secret"]);
  assert.equal(read.quotaRpm, 30);
  assert.deepEqual(stripFields({ name: "Ada", secret: "hidden", nested: { secret: "x" } }, ["secret"]), {
    name: "Ada",
    nested: {},
  });
});

test("a failed parameter constraint does not match the allow rule", () => {
  const constrained: PolicyRule[] = [{ effect: "allow", parameters: { status: { enum: ["open"] } } }];
  assert.equal(evaluatePolicy(constrained, ctx({ parameters: { status: "closed" } })).decision, "deny");
  assert.equal(evaluatePolicy(constrained, ctx({ parameters: { status: "open" } })).decision, "allow");
});

test("lifecycle publish stays blocked until validation and approval", () => {
  assert.equal(transition("draft", "publish"), null);
  assert.equal(transition("validated", "publish", { approvalRequired: true, approved: true }), null);
  assert.equal(transition("validated", "approve"), "reviewed");
  assert.equal(transition("reviewed", "publish", { approvalRequired: true, approved: true }), "published");
  assert.equal(transition("validated", "publish", { approvalRequired: false }), "published");
  assert.equal(transition("published", "edit"), null);
  assert.equal(transition("validated", "edit"), "configured");
});

test("tenant visibility, credential view, and agent publication stay closed", () => {
  assert.equal(canInstantiate("all", [], "org-a"), true);
  assert.equal(canInstantiate("selected", ["org-b"], "org-a"), false);
  assert.equal(canInstantiate("internal", [], "org-a"), false);
  assert.equal(canInstantiate("disabled", [], "org-a"), false);
  const view = publicCredential({
    sealedSecret: "sealed-secret",
    revokedAt: null,
    expiresAt: null,
    label: "crm",
  });
  assert.equal(view.hasSecret, true);
  assert.equal("sealedSecret" in view, false);
  assert.equal(
    publicationBlock({
      status: "reviewed",
      approvalRequired: false,
      approved: true,
      checks: { configuration: true, schema: true, permission: true },
      actor: "agent",
    }),
    "approval_required",
  );
  const merged = mergePolicyLayers([
    { scope: "platform", version: 2, rules: [{ effect: "deny", effects: ["destructive"] }] },
    { scope: "company", version: 4, rules: [{ effect: "allow", effects: ["read"] }] },
  ]);
  assert.equal(merged.version, 4);
  assert.equal(merged.rules.length, 2);
});

test("mcp listing hides a tool the policy denies", () => {
  const tool: CallableTool = {
    name: "delete_record",
    description: "Delete",
    inputSchema: { type: "object" },
    toolId: "tool-1",
    connectionId: "conn-1",
    version: 1,
    operation: "delete_record",
    sideEffect: "destructive",
    rules,
    policyVersion: 1,
    execution: { timeoutMs: 1000, maxRetries: 0, maxResponseBytes: 1000, requiresApproval: true, environment: "production" },
    approved: false,
  };
  const read: CallableTool = { ...tool, name: "find_customers", operation: "find_customers", sideEffect: "read", execution: { ...tool.execution, requiresApproval: false } };
  assert.equal(authorizeTool(tool, {}, now, "production").decision, "deny");
  assert.equal(authorizeTool(read, {}, now, "production").decision, "allow");
  assert.deepEqual(visibleTools([tool, read], now, "production").map((item) => item.name), ["find_customers"]);
});
