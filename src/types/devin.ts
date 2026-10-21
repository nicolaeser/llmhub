export type ProtoField = {
  field: number;
  wire: number;
  varint: bigint;
  bytes: Uint8Array;
};

export type ConnectFrame = {
  flag: number;
  payload: Uint8Array;
};

export type DevinPromptSource = 1 | 2 | 4;

export type DevinImage = {
  data: string;
  mimeType: string;
};

export type DevinToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type DevinPrompt = {
  source: DevinPromptSource;
  content: string;
  images: DevinImage[];
  toolCalls: DevinToolCall[];
  toolCallId: string;
  thinking: string;
  signature: string;
  signatureType: string;
};

export type DevinTool = {
  name: string;
  description: string;
  parameters: string;
};

export type DevinRequest = {
  model: string;
  system: string;
  prompts: DevinPrompt[];
  tools: DevinTool[];
  temperature: number | null;
  maxTokens: number;
  session: string;
};

export type DevinToolCallDelta = {
  id: string;
  name: string;
  arguments: string;
};

export type DevinUsage = {
  prompt: number;
  completion: number;
  cacheWrite: number;
  cacheRead: number;
  model: string;
};

export type DevinFrame = {
  text: Uint8Array[];
  thinking: Uint8Array[];
  signature: Uint8Array;
  signatureType: string;
  toolCalls: DevinToolCallDelta[];
  usage: DevinUsage | null;
  stopReason: number;
  dimensions: Uint8Array[];
};

export type DevinTrailer = {
  status: number;
  code: string;
  message: string;
};

export type DevinUserStatus = {
  email: string;
  userName: string;
  userId: string;
  teamId: string;
  orgId: string;
  orgName: string;
  plan: string;
  dailyRemaining: number | null;
  weeklyRemaining: number | null;
  dailyResetAt: number | null;
  weeklyResetAt: number | null;
  planStart: number | null;
  planEnd: number | null;
};

export type DevinProfile = {
  userName: string;
  userId: string;
  orgId: string;
};

export type DevinModelConfig = {
  uid: string;
  label: string;
  multimodal: boolean;
  vendor: number;
  contextLength: number;
};

export type DevinVariant = {
  base: string;
  effort: string;
  tier: DevinTierMode;
};

export type DevinTierMode = "" | "fast" | "priority";

export type DevinResetLookup = (windowSeconds: number) => number | null;

export type DevinReply = { status: number; data: Uint8Array; retryAfter: string | null };
