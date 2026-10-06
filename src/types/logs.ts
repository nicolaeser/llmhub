export type Kind = "requests" | "spend" | "audit";

export type LogFilterValues = {
  model: string;
  status: string;
  endpoint: string;
  keyId: string;
  userId: string;
  pii: boolean;
  from: string;
  to: string;
};

export type ContentSkip = "" | "gateway" | "user" | "member" | "key";

export type TranscriptKind = "text" | "reasoning" | "tool_call" | "tool_result" | "media";

export type TranscriptEntry = {
  role: string;
  kind: TranscriptKind;
  name?: string;
  text: string;
};

export type LogPayload = { value: unknown; truncated: boolean };

export type LogOption = { id: string; label: string };

export type LogOptions = {
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
  cost: number;
  piiMode: string;
  piiInput: string[];
  piiOutput: string[];
  hasContent: boolean;
  contentSkip: string;
};

export type RequestLogContentView = {
  request: unknown;
  response: unknown;
  truncated: boolean;
  input: TranscriptEntry[];
  output: TranscriptEntry[];
};

export type RequestLogDetail = RequestLogRow & {
  teamLabel: string;
  orgLabel: string;
  projectLabel: string;
  deploymentId: string;
  provider: string;
  upstreamModel: string;
  tag: string;
  error: string;
  canViewContent: boolean;
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
