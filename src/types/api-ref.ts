export type OverlayState = {
  isOpen: boolean;
  open: () => void;
  close: () => void;
  toggle: () => void;
  setOpen: (open: boolean) => void;
};

export type TrySnapshot = {
  status: number;
  latencyMs: number;
  contentType: string;
  bytes: number;
  binary: boolean;
  body: string;
};

export type OpenApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type OpenApiStyle = "openai" | "anthropic" | "dual" | "management";

export type OpenApiHeader = {
  name: string;
  direction: "request" | "response";
};

export type OpenApiPath = {
  method: OpenApiMethod;
  path: string;
  summary: string;
  style: OpenApiStyle;
  headers?: readonly OpenApiHeader[];
};

export type TryTarget =
  | { ok: true; method: OpenApiMethod; path: string }
  | { ok: false; error: "UNKNOWN_ENDPOINT" | "MISSING_PARAM" };

export type ConnectRoute = "api" | "subscription";

export type ConnectGuideData = {
  keyCount: number;
  models: Record<ConnectRoute, string[]>;
  canCreateKey: boolean;
  canSeeLogs: boolean;
};
