import type { EndpointView, ExecutionPolicy, WorkflowGraph, WorkflowNode } from "@/types/integrations";

export function policyFor(endpoints: readonly EndpointView[]): ExecutionPolicy {
  const risky = endpoints.some((endpoint) => endpoint.sideEffect === "destructive" || endpoint.sideEffect === "sensitive");
  return {
    timeoutMs: 30_000,
    maxRetries: endpoints.every((endpoint) => endpoint.sideEffect === "read") ? 1 : 0,
    maxResponseBytes: 1_000_000,
    requiresApproval: risky,
    environment: "production",
  };
}

export function graphFor(endpoints: readonly EndpointView[]): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    { id: "validate", type: "validate", schema: { type: "object" }, next: endpoints[0] ? "perm_0" : "output" },
  ];
  const map: Record<string, string> = {};
  endpoints.forEach((endpoint, index) => {
    const request = `req_${index}`;
    const next = endpoints[index + 1] ? `perm_${index + 1}` : "output";
    nodes.push({ id: `perm_${index}`, type: "permission", operation: endpoint.operationId, next: request });
    nodes.push({
      id: request,
      type: "request",
      method: endpoint.method,
      path: endpoint.path,
      endpointId: endpoint.operationId,
      body: endpoint.method === "GET" || endpoint.method === "HEAD" ? undefined : "{{input}}",
      next,
    });
    map[`op_${index}`] = `steps.${request}`;
  });
  nodes.push({ id: "output", type: "output", map });
  return { start: "validate", nodes };
}
