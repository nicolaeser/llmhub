import type { JsonMap, Principal } from "@/types/gateway";

export type BatchEndpoint =
  | "/v1/chat/completions"
  | "/v1/responses"
  | "/v1/completions"
  | "/v1/embeddings"
  | "/v1/moderations"
  | "/v1/images/generations";

export type BatchLine = {
  line: number;
  customId: string;
  body: JsonMap;
};

export type BatchLineError = {
  code: string;
  message: string;
  line: number;
  param: string | null;
};

export type BatchSnapshot = {
  actor: string;
  keyId: string;
  teamId: string;
  orgId: string;
  userId: string;
  models: string[];
};

export type BatchLineResult =
  | { ok: true; body: JsonMap; usage: unknown }
  | { ok: false; status: number; error: JsonMap };

export type BatchRun = {
  principal: Principal;
  endpoint: BatchEndpoint;
};
