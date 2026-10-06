import type { z } from "zod";
import type { ASSISTANT_EXPLAIN, ASSISTANT_PAGES } from "@/lib/assistant/knowledge";
import type { Permission } from "@/types/auth";
import type { LogFilterValues } from "@/types/logs";

export type SetupNext = "connect_provider" | "add_model" | "create_key" | "ready";

export type PublicKeyView = {
  id: string;
  alias: string;
  prefix: string;
  spend: number;
  maxBudget: number;
  blocked: boolean;
};

type AssistantRole = "user" | "assistant" | "tool" | "system";

export type AssistantMessage = {
  role: AssistantRole;
  content: string;
  toolCalls?: AssistantToolCall[];
  toolCallId?: string;
  name?: string;
};

export type AssistantToolChoice = "auto" | "none";

export type AssistantToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type McpToolDef = {
  name: AssistantToolName;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type AssistantToolStatus = "running" | "done" | "error" | "stopped";

export type AssistantEvent =
  | { type: "text"; delta: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      status: "done" | "error";
      result: unknown;
      href?: string;
    }
  | { type: "secret"; id: string; value: string }
  | { type: "done" }
  | { type: "error"; message: string };

export type AssistantToolPart = {
  type: "tool";
  id: string;
  name: string;
  status: AssistantToolStatus;
  args: Record<string, unknown>;
  result?: unknown;
  href?: string;
  secret?: string;
};

export type AssistantPart = { type: "text"; text: string } | AssistantToolPart;

export type AssistantPartGroup =
  | { type: "text"; key: string; text: string }
  | { type: "tools"; key: string; tools: AssistantToolPart[] };

export type AssistantChatMessage = {
  id: string;
  role: "user" | "assistant";
  parts: AssistantPart[];
};

export type AssistantWirePart =
  | { type: "text"; text: string }
  | {
      type: "tool";
      name: string;
      args: Record<string, unknown>;
      result: unknown;
    };

export type AssistantWireMessage =
  | { role: "user" | "assistant"; content: string }
  | { role: "assistant"; parts: AssistantWirePart[] };

export type UsageBreakdownGroup =
  | "model"
  | "org"
  | "team"
  | "project"
  | "member"
  | "key"
  | "user";

export type UsageBreakdownSort = "spend" | "requests" | "errors";

export type UsageBreakdownQuery = {
  groupBy: UsageBreakdownGroup;
  days: number;
  model: string;
  sort: UsageBreakdownSort;
  limit: number;
};

export type LogSearchQuery = {
  filters: LogFilterValues;
  errorsOnly: boolean;
  limit: number;
};

export type AssistantLocale = "en" | "de";

export type AssistantPage = keyof typeof ASSISTANT_PAGES;

export type AssistantTopic = keyof typeof ASSISTANT_EXPLAIN;

export type AssistantToolName =
  | "get_setup_status"
  | "whoami"
  | "explain"
  | "open_page"
  | "list_provider_kinds"
  | "list_api_endpoints"
  | "code_example"
  | "get_overview"
  | "get_usage"
  | "search_logs"
  | "usage_breakdown"
  | "search_audit_log"
  | "get_log"
  | "list_providers"
  | "get_provider"
  | "create_provider"
  | "update_provider"
  | "refresh_provider_models"
  | "import_provider_models"
  | "delete_provider"
  | "list_models"
  | "get_model"
  | "create_model"
  | "update_model"
  | "delete_model"
  | "list_model_templates"
  | "save_model_template"
  | "delete_model_template"
  | "list_keys"
  | "get_key"
  | "create_key"
  | "update_key"
  | "rotate_key"
  | "revoke_key"
  | "get_structure"
  | "save_structure_node"
  | "delete_structure_node"
  | "set_budget"
  | "add_budget_boost"
  | "remove_budget_boost"
  | "set_budget_alerts"
  | "list_users"
  | "list_roles"
  | "set_user_blocked"
  | "assign_user_role"
  | "revoke_user_sessions"
  | "get_settings"
  | "get_guardrails"
  | "test_pii"
  | "update_guardrails"
  | "update_gateway_settings";

export type AssistantToolGroup =
  | "general"
  | "usage"
  | "providers"
  | "models"
  | "keys"
  | "structure"
  | "access"
  | "settings";

export type AssistantToolAccess = "read" | "write" | "destructive";

export type AssistantToolMeta = {
  group: AssistantToolGroup;
  access: AssistantToolAccess;
  permission: Permission | null;
};

export type AssistantToolGate = {
  permissions: readonly Permission[];
  disabledTools: readonly AssistantToolName[];
  allowWrite: boolean;
};

export type AssistantContext = {
  userId: string;
  permissions: Permission[];
  disabledTools: AssistantToolName[];
  orgId: string | null;
  locale: AssistantLocale;
  allowWrite: boolean;
};

export type AssistantToolResult = {
  result: unknown;
  navigate?: string;
  secret?: string;
};

export type AssistantToolSpec = {
  description: string;
  input: z.ZodType;
  call: (args: Record<string, unknown>, ctx: AssistantContext) => Promise<AssistantToolResult>;
};

export type AssistantToolView = {
  name: AssistantToolName;
  access: AssistantToolAccess;
};

export type AssistantModelSettings = {
  assistant_model?: string;
  assistant_model_locked?: boolean;
};
