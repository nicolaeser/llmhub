import type { AssignmentScope, AssignmentSource } from "@/types/providers";
import type { JsonMap, Principal } from "@/types/gateway";
import type { OutputGuard } from "@/types/guardrails";

export type McpAuthType = "none" | "bearer" | "header";

export type McpAssignmentMode = "allow" | "block";

export type McpServerStatus = "connected" | "error" | "disabled" | "unchecked";

export type McpToolSpec = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonMap;
};

export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  authSecret: string;
  internal: boolean;
};

export type McpAssignmentRule = {
  serverId: string;
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  memberId: string | null;
  keyId: string | null;
  mode: McpAssignmentMode;
  blockedTools: string[];
};

export type McpChain = {
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  keyId: string;
};

export type McpServerPolicy = {
  id: string;
  name: string;
  global: boolean;
  enabled: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
  tools: McpToolSpec[];
};

export type McpEffectiveServer = {
  serverId: string;
  serverName: string;
  tools: McpToolSpec[];
};

export type McpBoundTool = {
  name: string;
  serverId: string;
  serverName: string;
  tool: McpToolSpec;
};

export type McpToolOutcome = {
  text: string;
  isError: boolean;
};

export type McpToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type McpExecutor = {
  call(bound: McpBoundTool, args: JsonMap, signal: AbortSignal): Promise<McpToolOutcome>;
  close(): Promise<void>;
};

export type McpToolset = {
  tools: McpBoundTool[];
  byName: Map<string, McpBoundTool>;
  executor: McpExecutor;
};

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<Response>;

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type McpServerView = {
  id: string;
  name: string;
  description: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  hasSecret: boolean;
  internal: boolean;
  enabled: boolean;
  global: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
  tools: McpToolSpec[];
  refreshedAt: string | null;
  lastError: string;
  status: McpServerStatus;
  assignments: McpAssignmentView[];
  updatedAt: string;
};

export type McpAssignmentView = {
  scope: AssignmentScope;
  id: string;
  label: string;
  mode: McpAssignmentMode;
  blockedTools: string[];
};

export type McpAssignmentInput = {
  scope: AssignmentScope;
  id: string;
  mode: McpAssignmentMode;
  blockedTools: string[];
};

export type McpTargetOption = {
  id: string;
  label: string;
  detail: string;
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
};

export type McpTargetOptions = Record<AssignmentScope, McpTargetOption[]>;

export type McpServerInput = {
  name: string;
  description: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  secret: string;
  clearSecret: boolean;
  internal: boolean;
  enabled: boolean;
  global: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
};

export type McpProbeResult = {
  connected: boolean;
  tools: McpToolSpec[];
  serverName: string;
  error: string;
};

export type McpExplanation = {
  state: "granted" | "blocked" | "none";
  grantedBy: McpAssignmentView[];
  blockedBy: McpAssignmentView[];
  global: boolean;
  blockedTools: string[];
  tools: string[];
};

export type McpLoopLimits = {
  maxSteps: number;
  deadline: number;
};

export type McpUrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; code: "MCP_URL_INVALID" | "MCP_URL_INSECURE" | "MCP_URL_BLOCKED" };

export type McpLoopContext = {
  principal: Principal;
  model: string;
  aliases: string[];
  outputGuard: OutputGuard | null;
  toolset: McpToolset;
  maxCost: number | null;
  signal?: AbortSignal;
};

export type McpCallRecord = {
  call: McpToolCall;
  bound: McpBoundTool;
  outcome: McpToolOutcome;
  content: string;
};

export type McpChatStep = {
  message: JsonMap;
  calls: McpCallRecord[];
};

export type McpChatRun = {
  final: JsonMap;
  transcript: JsonMap[];
  steps: McpChatStep[];
};

export type McpStreamSink = {
  start(): string[];
  chunk(chunk: JsonMap): string[];
  toolStart(call: McpToolCall, bound: McpBoundTool): { index: number; events: string[] };
  toolEnd(index: number, record: McpCallRecord): string[];
  finish(): string[];
  fail(message: string): string[];
  done(transcript: JsonMap[]): Promise<void>;
};

export type McpStreamSlot = {
  id: string;
  name: string;
  arguments: string;
  kind: "pending" | "mcp" | "caller";
  out: number;
  held: JsonMap[];
};

export type McpMessagesBlock = {
  block: JsonMap;
  mcp: boolean;
  out: number;
  json: string;
};

export type McpAssignmentSource = AssignmentSource & { mode: string; blockedTools: string[] };
