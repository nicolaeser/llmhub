import type { Permission } from "@/types/auth";
import type { LogFilterValues } from "@/types/logs";

export type SetupNext = "connect_provider" | "add_model" | "create_key" | "ready";

export type PublicKeyView = {
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
  name: string;
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
  | "team"
  | "org"
  | "project"
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

export type AssistantContext = {
  userId: string;
  permissions: Permission[];
  teamId: string;
  orgId: string;
  locale: AssistantLocale;
  allowWrite: boolean;
};
