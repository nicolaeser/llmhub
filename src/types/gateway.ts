import type { CostCap } from "@/types/billing";
import type { OutputGuard, PiiMode } from "@/types/guardrails";
import type { VirtualKeyView } from "@/types/keys";
import type { RouteLimits } from "@/types/model-templates";
import type { PublicPool, ResolvedDeployment, ResolvedModelGroup, RoutePool } from "@/types/routing";

export type JsonMap = Record<string, unknown>;

export type Principal = {
  actor: string;
  key?: VirtualKeyView;
  teamId: string;
  orgId: string;
  userId: string;
  memberId: string;
  models: string[];
  routeLimits: RouteLimits;
  dataRules?: boolean;
  pool?: RoutePool;
  system?: SystemFeature;
  client?: RequestClient;
  trace?: RequestTrace;
};

export type RequestClient = { session: string; agent: string };

export type SystemFeature = "catalog" | "kickoff" | "mcp_builder" | "model_test" | "pii";

export type RequestTrace = {
  endpoint: string;
  request?: unknown;
  piiMode: PiiMode | "";
  piiInput: Set<string>;
  piiOutput: Set<string>;
  guardInput: Set<string>;
  guardOutput: Set<string>;
  guardBlocked: boolean;
  costCap?: CostCap | null;
  labels?: LabelCandidates;
};

export type LabelCandidates = Record<string, string>;

export type ScreenedRequest = {
  principal: Principal;
  model: string;
  body: JsonMap;
  clean: JsonMap;
  output: OutputGuard | null;
};

export type ScreenOptions = {
  pool?: PublicPool;
  auth?: Request;
};

export type ProxyFirstResult = {
  status: number;
  json: unknown;
  raw: Uint8Array;
  contentType: string;
  depId: string;
  alias: string;
  dep: ResolvedDeployment;
  group: ResolvedModelGroup;
};

export type HubServiceMode = "fast" | "ultrafast" | "priority" | "flex" | "default" | "";

export type ModeSupport = "confirmed" | "unverified" | "none";

export type ChatSseTranslator = {
  pushLine(line: string): string[];
  flush(): string | null;
};

export type ReasoningSignatureCheck = (value: unknown) => value is string;

export type ResponsesStreamOptions = {
  isSignature?: ReasoningSignatureCheck;
  onEvent?: (type: string, data: JsonMap) => void;
  failure?: (data: JsonMap) => Error;
};

export type StoredObjectRecord = {
  id: string;
  kind: string;
  owner: string;
  filename: string;
  purpose: string;
  contentType: string;
  bytes: number;
  payload: Uint8Array;
  meta: Record<string, unknown>;
  createdAt: Date;
};

export type StoredPayloadLocation = {
  backend: "s3";
  key: string;
  url?: string;
};

