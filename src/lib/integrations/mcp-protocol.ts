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
