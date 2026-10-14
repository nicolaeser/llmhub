import { McpError } from "@/lib/mcp/errors";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { evaluatePolicy, stripFields } from "@/lib/integrations/policy";
import type {
  EndpointDraft,
  ExecutionPolicy,
  PolicyDecision,
  PolicyRule,
  StepRecord,
  WorkflowGraph,
  WorkflowNode,
  WorkflowResult,
} from "@/types/integrations";

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicy = {
  timeoutMs: 30_000,
  maxRetries: 0,
  maxResponseBytes: 1_000_000,
  requiresApproval: false,
  environment: "production",
};

const MAX_STEPS = 32;

export type WorkflowFetch = (input: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
}) => Promise<{ status: number; body: string; headers?: Record<string, string> }>;

export type WorkflowDeps = {
  fetch: WorkflowFetch;
  baseUrl: string;
  internal: boolean;
  authHeaders: Record<string, string>;
  endpoints: readonly EndpointDraft[];
  rules: readonly PolicyRule[];
  policyVersion?: number;
  execution: ExecutionPolicy;
  approved?: boolean;
  allowQuota?: (key: string, rpm: number) => boolean | Promise<boolean>;
  complete?: (prompt: string) => Promise<string>;
  now?: Date;
};

function lookup(root: unknown, path: string): unknown {
  let current = root;
  for (const part of path.split(".").filter(Boolean)) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function render(value: unknown, ctx: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/.exec(value);
    if (whole) {
      const found = lookup(ctx, whole[1]);
      return found === undefined ? "" : found;
    }
    return value.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_match, path: string) => {
      const found = lookup(ctx, path);
      return found == null ? "" : String(found);
    });
  }
  if (Array.isArray(value)) return value.map((item) => render(item, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = render(item, ctx);
    return out;
  }
  return value;
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const root = base.endsWith("/") ? base.slice(0, -1) : base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${root}${suffix}`;
}

function inputErrors(schema: Record<string, unknown>, value: unknown): string[] {
  if (schema.type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) return ["input_not_object"];
  const required = Array.isArray(schema.required) ? schema.required.filter((item) => typeof item === "string") : [];
  const rec = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return required.filter((key) => rec[key] == null || rec[key] === "").map((key) => `missing_${key}`);
}

function nodeMap(graph: WorkflowGraph): Map<string, WorkflowNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function decide(
  deps: WorkflowDeps,
  tool: string,
  operation: string,
  sideEffect: EndpointDraft["sideEffect"],
  parameters: Record<string, unknown>,
): PolicyDecision {
  return evaluatePolicy(
    deps.rules,
    {
      tool,
      operation,
      sideEffect,
      resource: operation,
      parameters,
      environment: deps.execution.environment,
      now: deps.now ?? new Date(),
    },
    deps.policyVersion ?? 1,
  );
}

async function requestNode(
  node: WorkflowNode,
  ctx: Record<string, unknown>,
  deps: WorkflowDeps,
  tool: string,
): Promise<StepRecord> {
  const method = (node.method ?? "GET").toUpperCase();
  const path = String(render(node.path ?? "/", ctx));
  const operation = node.endpointId || node.operation || `${method} ${path}`;
  const known = deps.endpoints.find((item) => item.operationId === operation);
  const effect = known?.sideEffect ?? (method === "GET" || method === "HEAD" ? "read" : "write");
  const parameters = (ctx.input && typeof ctx.input === "object" ? ctx.input : {}) as Record<string, unknown>;
  const decision = decide(deps, tool, operation, effect, parameters);
  if (decision.decision !== "allow") {
    return { id: node.id, type: node.type, ok: false, operation, error: decision.reason, output: decision };
  }
  if ((decision.approval || deps.execution.requiresApproval) && !deps.approved) {
    return { id: node.id, type: node.type, ok: false, operation, error: "approval_required", output: decision };
  }
  if (decision.quotaRpm && deps.allowQuota && !(await deps.allowQuota(`${tool}:${operation}`, decision.quotaRpm))) {
    return { id: node.id, type: node.type, ok: false, operation, error: "rate_limited" };
  }
  const url = joinUrl(deps.baseUrl, path);
  const verdict = checkServerUrl(url, deps.internal);
  if (!verdict.ok) return { id: node.id, type: node.type, ok: false, operation, error: verdict.code };
  const headers: Record<string, string> = { accept: "application/json", ...deps.authHeaders };
  const bodyValue = node.body === undefined ? undefined : render(node.body, ctx);
  const body = bodyValue === undefined ? undefined : JSON.stringify(bodyValue);
  if (body) headers["content-type"] = "application/json";
  let attempt = 0;
  let lastError = "upstream_failed";
  const retries = method === "GET" || method === "HEAD" ? deps.execution.maxRetries : 0;
  while (attempt <= retries) {
    attempt += 1;
    const signal = AbortSignal.timeout(deps.execution.timeoutMs);
    try {
      const response = await deps.fetch({ url: verdict.url.toString(), method, headers, body, signal });
      if (response.status >= 300 && response.status < 400) {
        return { id: node.id, type: node.type, ok: false, status: response.status, operation, error: "redirect_blocked" };
      }
      if (response.body.length > deps.execution.maxResponseBytes) {
        return { id: node.id, type: node.type, ok: false, status: response.status, operation, error: "response_too_large" };
      }
      if (response.status >= 500 && attempt <= retries) {
        lastError = "upstream_failed";
        continue;
      }
      let parsed: unknown = response.body;
      try {
        parsed = response.body ? JSON.parse(response.body) : null;
      } catch {
        parsed = response.body.slice(0, 2000);
      }
      parsed = stripFields(parsed, decision.denyFields);
      if (response.status >= 400) {
        return { id: node.id, type: node.type, ok: false, status: response.status, operation, error: "upstream_rejected", output: parsed };
      }
      return { id: node.id, type: node.type, ok: true, status: response.status, operation, output: parsed };
    } catch (err) {
      if (err instanceof McpError) {
        return { id: node.id, type: node.type, ok: false, operation, error: err.code };
      }
      lastError = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "upstream_failed";
    }
  }
  return { id: node.id, type: node.type, ok: false, operation, error: lastError };
}

function transform(node: WorkflowNode, ctx: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const assignment of node.assignments ?? []) {
    if (assignment.from) out[assignment.target] = lookup(ctx, assignment.from);
    else if (assignment.template !== undefined) out[assignment.target] = render(assignment.template, ctx);
    else out[assignment.target] = assignment.const;
  }
  return out;
}

export async function executeWorkflow(
  graph: WorkflowGraph,
  input: Record<string, unknown>,
  deps: WorkflowDeps,
  tool = "tool",
): Promise<WorkflowResult> {
  const nodes = nodeMap(graph);
  const ctx: Record<string, unknown> = { input, steps: {}, item: undefined };
  const steps: StepRecord[] = [];
  let cursor: string | undefined = graph.start;
  let guard = 0;
  let decision: PolicyDecision | null = null;
  const seen = new Set<string>();

  const runOne = async (node: WorkflowNode): Promise<StepRecord> => {
    if (node.type === "validate") {
      const errors = inputErrors(node.schema ?? {}, input);
      return { id: node.id, type: node.type, ok: errors.length === 0, error: errors[0], output: { errors } };
    }
    if (node.type === "permission") {
      const operation = node.operation ?? "*";
      const known = deps.endpoints.find((item) => item.operationId === operation);
      decision = decide(deps, tool, operation, known?.sideEffect ?? "read", input);
      const ok = decision.decision === "allow" && (!decision.approval || Boolean(deps.approved));
      return { id: node.id, type: node.type, ok, operation, error: ok ? undefined : decision.reason === "allow_rule" ? "approval_required" : decision.reason, output: decision };
    }
    if (node.type === "request") return requestNode(node, ctx, deps, tool);
    if (node.type === "transform") return { id: node.id, type: node.type, ok: true, output: transform(node, ctx) };
    if (node.type === "output") {
      const output: Record<string, unknown> = {};
      for (const [key, path] of Object.entries(node.map ?? {})) output[key] = lookup(ctx, path);
      return { id: node.id, type: node.type, ok: true, output: Object.keys(output).length ? output : ctx.steps };
    }
    if (node.type === "approval") {
      if (deps.approved) return { id: node.id, type: node.type, ok: true, output: { approved: true } };
      return { id: node.id, type: node.type, ok: false, error: "approval_required", output: { prompt: node.prompt ?? "" } };
    }
    if (node.type === "rate_limit") {
      const rpm = node.rpm ?? 60;
      const allowed = deps.allowQuota ? await deps.allowQuota(`${tool}:${node.id}`, rpm) : true;
      return { id: node.id, type: node.type, ok: allowed, error: allowed ? undefined : "rate_limited" };
    }
    if (node.type === "model") {
      if (!node.enabled) return { id: node.id, type: node.type, ok: true, skipped: true, error: "model_step_disabled" };
      if (!deps.complete) return { id: node.id, type: node.type, ok: false, error: "model_not_configured" };
      const prompt = String(render(node.prompt ?? "", ctx));
      const text = await deps.complete(prompt);
      return { id: node.id, type: node.type, ok: true, output: { text } };
    }
    if (node.type === "condition") return { id: node.id, type: node.type, ok: true };
    if (node.type === "loop") return { id: node.id, type: node.type, ok: true };
    if (node.type === "error") return { id: node.id, type: node.type, ok: true };
    return { id: node.id, type: node.type, ok: false, error: "unsupported_node" };
  };

  while (cursor && guard < MAX_STEPS) {
    guard += 1;
    const node = nodes.get(cursor);
    if (!node) return { status: "failed", output: null, steps, error: "missing_node", operation: "", decision };
    if (node.type === "loop") {
      const source = lookup(ctx, node.source ?? "");
      const items = Array.isArray(source) ? source.slice(0, node.max ?? 20) : [];
      const body = node.steps ?? [];
      for (const item of items) {
        ctx.item = item;
        for (const stepId of body) {
          const child = nodes.get(stepId);
          if (!child) return { status: "failed", output: null, steps, error: "missing_node", operation: "", decision };
          const record = await runOne(child);
          steps.push(record);
          (ctx.steps as Record<string, unknown>)[child.id] = record.output ?? null;
          if (!record.ok && !record.skipped) {
            const status = record.error === "approval_required" ? "approval_required" : record.error === "deny_rule" || record.error === "deny_by_default" ? "denied" : "failed";
            return { status, output: null, steps, error: record.error ?? "step_failed", operation: record.operation ?? "", decision };
          }
        }
      }
      cursor = node.next;
      continue;
    }
    if (node.type === "error" && node.try) {
      const child = nodes.get(node.try);
      if (!child) return { status: "failed", output: null, steps, error: "missing_node", operation: "", decision };
      const record = await runOne(child);
      if (record.ok || record.error === "approval_required" || record.error === "deny_rule" || record.error === "deny_by_default") {
        steps.push(record);
        (ctx.steps as Record<string, unknown>)[child.id] = record.output ?? null;
        if (!record.ok) {
          const status = record.error === "approval_required" ? "approval_required" : "denied";
          return { status, output: null, steps, error: record.error ?? "step_failed", operation: record.operation ?? "", decision };
        }
      } else {
        steps.push({ ...record, ok: true, output: node.fallback ?? null, error: undefined });
        (ctx.steps as Record<string, unknown>)[child.id] = node.fallback ?? null;
      }
      cursor = node.next;
      continue;
    }
    if (node.type === "condition") {
      const current = lookup(ctx, node.when?.path ?? "");
      const pass = node.when?.exists ? current != null : node.when && "equals" in node.when ? current === node.when.equals : Boolean(current);
      steps.push({ id: node.id, type: node.type, ok: true, output: { pass } });
      cursor = pass ? node.then : node.else;
      continue;
    }
    if (seen.has(node.id) && node.type !== "request") {
      return { status: "failed", output: null, steps, error: "cycle", operation: "", decision };
    }
    seen.add(node.id);
    const record = await runOne(node);
    steps.push(record);
    (ctx.steps as Record<string, unknown>)[node.id] = record.output ?? null;
    if (!record.ok && !record.skipped) {
      const status = record.error === "approval_required" ? "approval_required" : record.error === "deny_rule" || record.error === "deny_by_default" ? "denied" : "failed";
      return { status, output: record.output ?? null, steps, error: record.error ?? "step_failed", operation: record.operation ?? "", decision };
    }
    if (node.type === "output") {
      return { status: "succeeded", output: record.output, steps, error: "", operation: "", decision };
    }
    cursor = node.next;
  }
  if (guard >= MAX_STEPS) return { status: "failed", output: null, steps, error: "step_limit", operation: "", decision };
  const last = steps.at(-1);
  return { status: "succeeded", output: last?.output ?? null, steps, error: "", operation: last?.operation ?? "", decision };
}

export function operationTool(endpoint: EndpointDraft): WorkflowGraph {
  return {
    start: "validate",
    nodes: [
      { id: "validate", type: "validate", schema: { type: "object" }, next: "permission" },
      { id: "permission", type: "permission", operation: endpoint.operationId, next: "request" },
      {
        id: "request",
        type: "request",
        method: endpoint.method,
        path: endpoint.path,
        endpointId: endpoint.operationId,
        body: endpoint.method === "GET" || endpoint.method === "HEAD" ? undefined : "{{input}}",
        next: "output",
      },
      { id: "output", type: "output", map: { result: "steps.request" } },
    ],
  };
}

export function defaultPolicyFor(endpoint: EndpointDraft): ExecutionPolicy {
  return {
    ...DEFAULT_EXECUTION_POLICY,
    requiresApproval: endpoint.sideEffect === "destructive" || endpoint.sideEffect === "sensitive",
    ...endpoint.sideEffect === "read" ? { maxRetries: 1 } : {},
  };
}
