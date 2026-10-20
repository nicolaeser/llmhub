import "server-only";
import { allowRequest } from "@/lib/rate-limit/window";
import { guardedFetch } from "@/lib/mcp/transport";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { fail } from "@/lib/integrations/records";
import { executeWorkflow, type WorkflowFetch } from "@/lib/integrations/workflow";
import type { EndpointDraft, ExecutionPolicy, PolicyRule, WorkflowGraph, WorkflowResult } from "@/types/integrations";

async function readBody(response: Response, max: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total <= max) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > max) {
      await reader.cancel();
      return "response_too_large";
    }
    chunks.push(next.value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function integrationFetch(internal: boolean, maxBytes: number): WorkflowFetch {
  const send = guardedFetch(internal);
  return async (input) => {
    const response = await send(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: input.signal,
    });
    const body = await readBody(response, maxBytes);
    if (body === "response_too_large") return { status: response.status, body: "x".repeat(maxBytes + 1) };
    return { status: response.status, body };
  };
}

export function tokenFetch(internal: boolean) {
  const send = guardedFetch(internal);
  return async (input: { url: string; method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => {
    const verdict = checkServerUrl(input.url, internal);
    if (!verdict.ok) fail(verdict.code);
    const response = await send(input.url, { method: input.method, headers: input.headers, body: input.body, signal: input.signal });
    return { status: response.status, body: await response.text() };
  };
}

export async function runIntegrationWorkflow(input: {
  tool: string;
  graph: WorkflowGraph;
  args: Record<string, unknown>;
  endpoints: readonly EndpointDraft[];
  rules: readonly PolicyRule[];
  policyVersion: number;
  execution: ExecutionPolicy;
  baseUrl: string;
  internal: boolean;
  authHeaders: Record<string, string>;
  approved: boolean;
  quotaKey: string;
}): Promise<WorkflowResult> {
  return executeWorkflow(
    input.graph,
    input.args,
    {
      fetch: integrationFetch(input.internal, input.execution.maxResponseBytes),
      baseUrl: input.baseUrl,
      internal: input.internal,
      authHeaders: input.authHeaders,
      endpoints: input.endpoints,
      rules: input.rules,
      policyVersion: input.policyVersion,
      execution: input.execution,
      approved: input.approved,
      allowQuota: (key, rpm) => allowRequest(`${input.quotaKey}:${key}`, rpm, 60_000),
    },
    input.tool,
  );
}
