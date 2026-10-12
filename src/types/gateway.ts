import type { CostCap } from "@/types/billing";
import type { GuardrailPolicy, OutputGuard, PiiMode } from "@/types/guardrails";
import type { VirtualKeyView } from "@/types/keys";
import type { RouteLimits } from "@/types/model-templates";
import type { ResolvedDeployment, ResolvedModelGroup, RoutePool } from "@/types/routing";

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
  guardrails?: GuardrailPolicy | null;
  pool?: RoutePool;
  trace?: RequestTrace;
};

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
};

export type ScreenedRequest = {
  principal: Principal;
  model: string;
  body: JsonMap;
  clean: JsonMap;
  output: OutputGuard | null;
};

export type ScreenOptions = {
  pool?: RoutePool;
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

export type HubServiceMode = "fast" | "priority" | "flex" | "default" | "";

export type ChatSseTranslator = {
  pushLine(line: string): string[];
  flush(): string | null;
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

export type RedisLike = {
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hincrby(key: string, field: string, amount: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  mget(keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, mode: "PX", milliseconds: number): Promise<unknown>;
};
