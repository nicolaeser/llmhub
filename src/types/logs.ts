import type { Principal, SystemFeature } from "@/types/gateway";
import type { Deployment } from "@/types/routing";
import type { RequestLabel } from "@/types/usage";

export type LogKind = "requests" | "sessions" | "spend" | "audit";

export type NewLogsCount = { since: string; count: number; capped: boolean };

export type LogFilterValues = {
  model: string;
  status: string;
  endpoint: string;
  keyId: string;
  userId: string;
  label: string;
  session: string;
  pii: boolean;
  from: string;
  to: string;
};

export type ContentSkip = "" | "system" | "gateway" | "user" | "member" | "key";

export type TranscriptKind = "text" | "reasoning" | "tool_call" | "tool_result" | "media";

export type TranscriptEntry = {
  role: string;
  kind: TranscriptKind;
  name?: string;
  url?: string;
  text: string;
};

export type LogPayload = { value: unknown; truncated: boolean };

export type LogOption = { id: string; label: string };

export type LogOptions = {
  models: string[];
  keys: LogOption[];
  users: LogOption[];
};

export type RequestLogRow = {
  id: string;
  createdAt: string;
  model: string;
  endpoint: string;
  stream: boolean;
  status: number;
  outcome: string;
  latencyMs: number;
  keyId: string;
  keyLabel: string;
  userId: string;
  userLabel: string;
  memberId: string;
  memberLabel: string;
  teamId: string;
  orgId: string;
  projectId: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  piiMode: string;
  piiInput: string[];
  piiOutput: string[];
  guardInput: string[];
  guardOutput: string[];
  labels: RequestLabel[];
  hasContent: boolean;
  contentSkip: string;
  system: SystemFeature | "";
  sessionId: string;
  agent: string;
};

export type LogSessionRef = { sessionId: string; keyId: string; userId: string };

export type LogSessionModel = { model: string; requests: number };

export type LogSessionRow = LogSessionRef & {
  keyLabel: string;
  userLabel: string;
  memberId: string;
  memberLabel: string;
  agent: string;
  active: boolean;
  startedAt: string;
  lastAt: string;
  durationMs: number;
  requests: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  models: LogSessionModel[];
  accounts: number;
  accountSwitches: number;
};

export type LogSessionSortKey = "recent" | "cost" | "requests";

export type LogSessionSort = { by: LogSessionSortKey; direction: "asc" | "desc" };

export type LogSessionTotals = {
  active: number;
  requests: number;
  errors: number;
  cost: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
};

export type LogSessionList = {
  page: number;
  pageSize: number;
  total: number;
  capped: boolean;
  sort: LogSessionSort;
  totals: LogSessionTotals;
  sessions: LogSessionRow[];
};

export type LogSessionAccount = { index: number; label: string; provider: string; requests: number };

export type LogSessionRequest = RequestLogRow & {
  provider: string;
  account: number;
  accountSwitch: boolean;
  offsetMs: number;
};

export type LogSessionDetail = {
  session: LogSessionRow;
  accounts: LogSessionAccount[];
  page: number;
  pageSize: number;
  total: number;
  requests: LogSessionRequest[];
};

export type LogChatRequest = {
  id: string;
  createdAt: string;
  model: string;
  status: number;
  outcome: string;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cost: number;
  error: string;
  resent: number;
  repeated: boolean;
};

export type LogChatTurn = { request: LogChatRequest; input: TranscriptEntry[]; output: TranscriptEntry[] };

export type LogChatThread = { id: string; system: TranscriptEntry[]; models: string[]; turns: LogChatTurn[] };

export type LogSessionChat = {
  canViewContent: boolean;
  threads: LogChatThread[];
  total: number;
  scanned: number;
};

export type AccountStep = { provider: string; providerId: string };

export type RequestLogContentView = {
  request: unknown;
  response: unknown;
  truncated: boolean;
  input: TranscriptEntry[];
  output: TranscriptEntry[];
};

export type PiiRestoreSummary = { placeholders: string[]; text: string[]; tools: string[] };

export type RequestLogDetail = RequestLogRow & {
  teamLabel: string;
  orgLabel: string;
  projectLabel: string;
  deploymentId: string;
  provider: string;
  upstreamModel: string;
  tag: string;
  error: string;
  piiRestore: PiiRestoreSummary | null;
  canViewContent: boolean;
  replayable: boolean;
  content: RequestLogContentView | null;
};

export type RequestLogExportFormat = "pdf" | "md" | "json";

export type RequestLogDocumentEntry = {
  role: string;
  assistant: boolean;
  heading: string;
  kind: TranscriptKind;
  text: string;
};

export type RequestLogDocumentField = { label: string; value: string; mono?: boolean };

export type RequestLogDocument = {
  brand: string;
  title: string;
  subtitle: string;
  status: string;
  generated: string;
  error: { label: string; text: string } | null;
  fields: RequestLogDocumentField[];
  privacy: { heading: string; fields: RequestLogDocumentField[]; note: string };
  content: {
    heading: string;
    notice: string;
    truncated: string;
    conversation: string;
    empty: string;
    input: RequestLogDocumentEntry[];
    output: RequestLogDocumentEntry[];
    payloads: { heading: string; json: string }[];
    noJson: string;
  };
  piiLabel: (entity: string) => string;
  pageLabel: (page: number, total: number) => string;
};

export type RequestLogEntry = {
  principal: Principal;
  model: string;
  deployment?: Deployment | null;
  status: number;
  outcome: string;
  latencyMs: number;
  tag: string;
  labels?: RequestLabel[];
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  stream?: boolean;
  request?: unknown;
  response?: unknown;
  error?: unknown;
};
