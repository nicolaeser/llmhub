import type { z } from "zod";
import type { completionsRequestSchema } from "@/schemas/completions";
import type { responsesInputItemSchema, responsesRequestSchema } from "@/schemas/responses";
import type { JsonMap } from "@/types/gateway";

export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

export type ResponsesInputItem = z.infer<typeof responsesInputItemSchema>;

export type CompletionsRequest = z.infer<typeof completionsRequestSchema>;

export type RequestIssue = {
  code: string;
  path: PropertyKey[];
  message: string;
  errors?: RequestIssue[][];
};

export type ParsedRequest<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; param: string | null };

export type ChatStreamEncoder = {
  start(): string[];
  push(chunk: JsonMap): string[];
  finish(): string[];
  fail(message: string): string[];
};

export type ToolCallEvent =
  | { type: "start"; slot: number; id: string; name: string }
  | { type: "args"; slot: number; delta: string };

export type ToolCallEntry = {
  id: string;
  name: string;
  args: string;
  started: boolean;
  slot: number;
};

export type StoredResponse = { response: JsonMap; messages: JsonMap[]; input: JsonMap[] };

export type CompletionContext = {
  id: string;
  created: number;
  model: string;
  n: number;
  prompts: string[];
  echo: boolean;
};

export type CompletionStreamContext = {
  id: string;
  created: number;
  model: string;
  echo: string;
};

export type SseRelayOptions = {
  map?: (json: JsonMap, event: string) => JsonMap | null;
  onEnd?: () => Promise<void> | void;
};
