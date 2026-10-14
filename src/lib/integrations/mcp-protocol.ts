import { evaluatePolicy } from "@/lib/integrations/policy";
import type { ExecutionPolicy, PolicyDecision, PolicyRule, SideEffect } from "@/types/integrations";

export type CallableTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  toolId: string;
  connectionId: string;
  version: number;
  operation: string;
  sideEffect: SideEffect;
  rules: readonly PolicyRule[];
  policyVersion: number;
  execution: ExecutionPolicy;
  approved: boolean;
};

export type RpcMessage = { id: unknown; method: string; params: Record<string, unknown> };

export function parseRpc(body: unknown): RpcMessage | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_request" };
  const rec = body as Record<string, unknown>;
  if (rec.jsonrpc !== "2.0" || typeof rec.method !== "string") return { error: "invalid_request" };
  const params = rec.params && typeof rec.params === "object" && !Array.isArray(rec.params) ? (rec.params as Record<string, unknown>) : {};
  return { id: rec.id ?? null, method: rec.method, params };
}

export function rpcOk(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function rpcFail(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function visibleTools(tools: readonly CallableTool[], now: Date, environment: string): CallableTool[] {
  return tools.filter((tool) => authorizeTool(tool, {}, now, environment).decision === "allow");
}

export function authorizeTool(
  tool: CallableTool,
  args: Record<string, unknown>,
  now: Date,
  environment: string,
): PolicyDecision {
  return evaluatePolicy(
    tool.rules,
    {
      tool: tool.name,
      operation: tool.operation,
      sideEffect: tool.sideEffect,
      resource: tool.operation,
      parameters: args,
      environment,
      now,
    },
    tool.policyVersion,
  );
}

export function toolCard(tool: CallableTool): Record<string, unknown> {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}
