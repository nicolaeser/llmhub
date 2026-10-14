import { ingestDocument } from "@/lib/integrations/ingest";
import { evaluatePolicy } from "@/lib/integrations/policy";
import { slugify } from "@/lib/integrations/sanitize";
import { defaultPolicyFor, operationTool } from "@/lib/integrations/workflow";
import type {
  AgentDraftTool,
  AgentTurn,
  CheckResult,
  EndpointDraft,
  JsonSchema,
  PolicyRule,
  WorkflowGraph,
  WorkflowNode,
} from "@/types/integrations";

export type KnownIntegration = {
  id: string;
  name: string;
  slug: string;
  scope: "global" | "company";
};

function inputSchema(endpoint: EndpointDraft): JsonSchema {
  if (endpoint.requestSchema && Object.keys(endpoint.requestSchema).length > 0) return endpoint.requestSchema;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const parameter of endpoint.parameters) {
    properties[parameter.name] = Object.keys(parameter.schema).length ? parameter.schema : { type: "string" };
    if (parameter.required) required.push(parameter.name);
  }
  return { type: "object", properties, required };
}

function wantsNotes(message: string): boolean {
  return /\b(note|notes|comment|comments|notiz|notizen|kommentar)\b/i.test(message);
}

function forbids(message: string, word: RegExp): boolean {
  return word.test(message) && /\b(never|nicht|kein|dont|don't|must not|nicht)\b/i.test(message);
}

function selected(endpoints: readonly EndpointDraft[], message: string): EndpointDraft[] {
  const notes = wantsNotes(message);
  return endpoints.filter((endpoint) => {
    if (endpoint.sideEffect === "destructive" || endpoint.sideEffect === "sensitive") return false;
    if (endpoint.sideEffect === "read") return true;
    if (!notes) return false;
    return /\b(note|comment|notiz|kommentar)\b/i.test(`${endpoint.operationId} ${endpoint.summary}`);
  });
}

function workflowOf(endpoints: readonly EndpointDraft[]): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    { id: "validate", type: "validate", schema: { type: "object" }, next: endpoints[0] ? `perm_${endpoints[0].operationId}` : "output" },
  ];
  endpoints.forEach((endpoint, index) => {
    const next = endpoints[index + 1] ? `perm_${endpoints[index + 1].operationId}` : "output";
    nodes.push({
      id: `perm_${endpoint.operationId}`,
      type: "permission",
      operation: endpoint.operationId,
      next: `req_${endpoint.operationId}`,
    });
    nodes.push({
      id: `req_${endpoint.operationId}`,
      type: "request",
      method: endpoint.method,
      path: endpoint.path,
      endpointId: endpoint.operationId,
      body: endpoint.method === "GET" || endpoint.method === "HEAD" ? undefined : "{{input}}",
      next,
    });
  });
  const map: Record<string, string> = {};
  for (const endpoint of endpoints) map[endpoint.operationId] = `steps.req_${endpoint.operationId}`;
  nodes.push({ id: "output", type: "output", map });
  return { start: "validate", nodes };
}

function rulesFor(endpoints: readonly EndpointDraft[], message: string): PolicyRule[] {
  const writes = endpoints
    .filter((endpoint) => endpoint.sideEffect === "write")
    .map((endpoint) => endpoint.operationId);
  const rules: PolicyRule[] = [
    { effect: "deny", effects: ["destructive"] },
    { effect: "deny", effects: ["sensitive"] },
    { effect: "allow", effects: ["read"] },
  ];
  if (writes.length && wantsNotes(message)) rules.push({ effect: "allow", effects: ["write"], operations: writes });
  if (forbids(message, /\b(delet\w*|lösch\w*|destroy|remove)\b/i)) {
    rules.unshift({ effect: "deny", operations: ["*"] , effects: ["destructive"] });
  }
  return rules;
}

function reused(message: string, existing: readonly KnownIntegration[]): KnownIntegration | null {
  const text = message.toLowerCase();
  return (
    existing.find((item) => text.includes(item.slug.replaceAll("_", " ")) || text.includes(item.name.toLowerCase())) ??
    null
  );
}

function checksFor(endpoints: readonly EndpointDraft[], rules: readonly PolicyRule[]): CheckResult[] {
  const configuration = endpoints.length > 0;
  const schema = endpoints.every((endpoint) => endpoint.requestSchema && endpoint.responseSchema);
  const decision = evaluatePolicy(rules, {
    tool: "delete_record",
    operation: "delete_record",
    sideEffect: "destructive",
    resource: "/records",
    parameters: {},
    environment: "production",
    now: new Date("2026-01-01T00:00:00.000Z"),
  });
  const permissionOk = decision.decision === "deny";
  return [
    { name: "configuration", ran: true, ok: configuration, detail: configuration ? "endpoints_present" : "no_endpoints" },
    { name: "schema", ran: true, ok: schema, detail: schema ? "schemas_present" : "schema_missing" },
    { name: "authentication", ran: false, ok: false, detail: "not_executed" },
    { name: "connectivity", ran: false, ok: false, detail: "not_executed" },
    { name: "endpoint_test", ran: false, ok: false, detail: "not_executed" },
    {
      name: "permission_enforcement",
      ran: rules.length > 0,
      ok: permissionOk,
      detail: decision.reason,
    },
    { name: "production_readiness", ran: true, ok: false, detail: "draft" },
  ];
}

export function planIntegration(input: {
  message: string;
  spec?: string;
  scope: "global" | "company";
  existing: readonly KnownIntegration[];
}): AgentTurn {
  const match = reused(input.message, input.existing);
  const ingested = input.spec?.trim() ? ingestDocument(input.spec) : ingestDocument({ name: "Draft", endpoint: undefined });
  const usable = input.spec?.trim() ? ingested : { ...ingested, endpoints: [], limitations: ["spec_required", ...ingested.limitations] };
  const chosen = selected(usable.endpoints, input.message).map((endpoint) => ({ ...endpoint, enabled: true, origin: "local" as const }));
  const rules = rulesFor(chosen, input.message);
  const tools: AgentDraftTool[] = chosen.map((endpoint) => ({
    slug: slugify(endpoint.operationId),
    name: endpoint.summary || endpoint.operationId,
    description: `${endpoint.method} ${endpoint.path}. ${endpoint.summary}`.trim(),
    kind: "operation",
    inputSchema: inputSchema(endpoint),
    outputSchema: Object.keys(endpoint.responseSchema).length ? endpoint.responseSchema : { type: "object" },
    graph: operationTool(endpoint),
    executionPolicy: defaultPolicyFor(endpoint),
    operationIds: [endpoint.operationId],
  }));
  if (chosen.length > 1) {
    tools.push({
      slug: "resolve_context",
      name: "Resolve context",
      description: "Runs the allowed read operations and returns one normalized object. Destructive and sensitive operations stay denied.",
      kind: "workflow",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      graph: workflowOf(chosen.filter((endpoint) => endpoint.sideEffect === "read").slice(0, 4)),
      executionPolicy: defaultPolicyFor(chosen[0]!),
      operationIds: chosen.filter((endpoint) => endpoint.sideEffect === "read").slice(0, 4).map((endpoint) => endpoint.operationId),
    });
  }
  const assumptions = [
    ...(!input.spec?.trim() ? ["A specification or manual endpoint is still required."] : []),
    "Credentials are not assumed. Authentication and connectivity were not called.",
    "LLMHUB denies destructive and sensitive operations even when the provider token is broader.",
    ...(wantsNotes(input.message) ? ["Write access is limited to note or comment operations named in the specification."] : []),
  ];
  const explanation = match
    ? `An existing ${match.scope} integration named ${match.name} already covers this request. No second copy was created.`
    : `Draft ${input.scope} integration with ${chosen.length} allowed operation${chosen.length === 1 ? "" : "s"} and ${rules.length} policy rules. Nothing is published.`;
  return {
    state: "proposed",
    created: false,
    integrationId: match?.id ?? "",
    scope: input.scope,
    reused: match ? { id: match.id, name: match.name, scope: match.scope } : null,
    assumptions,
    limitations: usable.limitations,
    explanation,
    checks: checksFor(usable.endpoints, rules),
    endpoints: input.spec?.trim() ? usable.endpoints.map((endpoint) => ({ ...endpoint, enabled: chosen.some((item) => item.operationId === endpoint.operationId) })) : [],
    tools: match ? [] : tools,
    rules,
    modelCalled: false,
  };
}
