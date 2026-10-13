import "server-only";
import { recordUsageOrLog } from "@/lib/gateway/billing/billing";
import { spendTag } from "@/lib/gateway/access/gate";
import { GateError } from "@/lib/gateway/errors";
import { screenRequest } from "@/lib/gateway/safety/guardrails";
import { defaultEntityIds, redactJSON } from "@/lib/gateway/safety/pii";
import { resolvePolicies } from "@/lib/settings/enterprise";
import type { JsonMap, Principal } from "@/types/gateway";

async function reject(principal: Principal, model: string, body: JsonMap, error: GateError, outcome: string): Promise<never> {
  await recordUsageOrLog({
    principal,
    model,
    status: error.status,
    outcome,
    latencyMs: 0,
    tag: spendTag(body),
    request: principal.trace?.request ?? body,
    error,
  });
  throw error;
}

export async function screenToolResult(
  principal: Principal,
  model: string,
  body: JsonMap,
  text: string,
): Promise<string> {
  const { pii, guardrails } = await resolvePolicies(principal);
  const screened = screenRequest({ content: text }, guardrails, principal.trace?.guardInput ?? new Set());
  if (screened.blocked) {
    if (principal.trace) principal.trace.guardBlocked = true;
    return reject(
      principal,
      model,
      body,
      new GateError(400, "guardrail_blocked", "an MCP tool result was blocked by the guardrail policy"),
      "guardrail_blocked",
    );
  }
  const content = typeof screened.body.content === "string" ? screened.body.content : text;
  if (!pii.enabled) return content;
  const found = new Set<string>();
  const redacted = redactJSON(content, pii.entities.length ? pii.entities : defaultEntityIds(), "", found) as string;
  for (const id of found) principal.trace?.piiInput.add(id);
  if (pii.mode === "block" && found.size) {
    return reject(
      principal,
      model,
      body,
      new GateError(400, "pii_blocked", "an MCP tool result was blocked by the PII policy"),
      "pii_blocked",
    );
  }
  return redacted;
}

export async function traceStep(principal: Principal, body: JsonMap): Promise<void> {
  const trace = principal.trace;
  if (!trace) return;
  const { pii } = await resolvePolicies(principal);
  trace.request = pii.enabled
    ? redactJSON(body, pii.entities.length ? pii.entities : defaultEntityIds(), "", new Set())
    : body;
}
