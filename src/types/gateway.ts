import type { Prisma } from "@/generated/prisma/client";
import type { OPENAPI_METHODS } from "@/lib/gateway/openapi";
import type { WEBHOOK_EVENTS } from "@/lib/gateway/webhook-events";
import type { PiiPolicy } from "@/types/guardrails";
import type { RouteLimits } from "@/types/model-templates";

export type SpendHolder = {
  id: string;
  spend: Prisma.Decimal;
  maxBudget: Prisma.Decimal;
  budgetDuration: string;
  spendResetAt: Date | null;
  createdAt: Date;
};

export type PriceWindowRates = CostRates & {
  start_minute: number;
  end_minute: number;
};

export type PriceSchedule = {
  price: CostRates;
  time_zone: string;
  windows: PriceWindowRates[];
};

export type TokenPricing = {
  prompt: string;
  completion: string;
};

export type PublicModel = {
  alias: string;
  vendor: string;
  displayName: string;
  tags: string[];
  pricing: ModelPricing | null;
};

export type ModelPricing = TokenPricing & {
  schedule?: {
    time_zone: string;
    default: TokenPricing;
    windows: (TokenPricing & { start: string; end: string })[];
  };
};

export type BillingGroup = {
  alias: string;
  billing_mode: string;
  price_input_per_1k: number;
  price_output_per_1k: number;
  price_time_zone: string;
  price_windows: PriceWindowRates[];
  deployments: CostRates[];
};

export type BillingContext = {
  mode: string;
  peers: CostRates[];
  price?: CostRates;
};

export type Entry = { expires: number; body: Uint8Array };

export type KindSpec = {
  kind: string;
  name: string;
  default_base_url?: string;
};

export type Group = ModelGroup & { mapped: ResolvedDeployment[] };

export type CostRates = {
  cost_input_per_1k: number;
  cost_output_per_1k: number;
};

export type PriceFactors = {
  input: number;
  output: number;
  cacheRead: number;
};

export type BudgetForecast = {
  dailyAvg: number;
  projectedMonth: number;
  daysToExhaust: number | null;
  pctUsed: number | null;
};

export type Jwk = {
  kty?: string;
  kid?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
};

export type Cache = { url: string; keys: Map<string, string>; fetched: number };

export type JwtClaims = Record<string, unknown>;

export type Stored = {
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

export type StorageMeta = {
  backend: "s3";
  key: string;
  url?: string;
};

export type OpenApiMethod = (typeof OPENAPI_METHODS)[number];

export type OpenApiStyle = "openai" | "anthropic" | "dual" | "management";

export type OpenApiPath = {
  method: OpenApiMethod;
  path: string;
  summary: string;
  style: OpenApiStyle;
};

export type TryTarget =
  | { ok: true; method: OpenApiMethod; path: string }
  | { ok: false; error: "UNKNOWN_ENDPOINT" | "MISSING_PARAM" };

export type PIIEntity = {
  id: string;
  label: string;
  category: string;
  example: string;
  default?: boolean;
};

export type Rule = { id: string; apply: (text: string) => string };

export type PiiMode = "mask" | "block";

export type RequestTrace = {
  endpoint: string;
  request?: unknown;
  piiMode: PiiMode | "";
  piiInput: Set<string>;
  piiOutput: Set<string>;
};

export type DiscoveredModel = {
  id: string;
  name: string;
  ownedBy: string;
  contextLength: number;
  costInputPer1k: number;
  costOutputPer1k: number;
  priceSource: string;
};

export type ModelPrice = { in: number; out: number };

export type RepricedModel = { id: string; from: ModelPrice; to: ModelPrice };

export type DiscoveredDiff = {
  added: string[];
  removed: string[];
  repriced: RepricedModel[];
  changed: boolean;
};

export type CatalogPrice = {
  id: string;
  costInput: number;
  costOutput: number;
  priceSource: string;
};

export type Weighted = { id: string; weight: number };

export type DbDeployment = {
  id: string;
  kind: string;
  baseUrl: string;
  model: string;
  weight: number;
  costInput: Prisma.Decimal;
  costOutput: Prisma.Decimal;
  providerId: string | null;
  provider: {
    id: string;
    kind: string;
    baseUrl: string;
    apiKey: string;
    zdr: boolean;
    retentionDays: number | null;
    region: string;
    noTraining: boolean;
  } | null;
};

export type ResolvedDeployment = Deployment & {
  provider?: DbDeployment["provider"];
};

export type ScimUser = {
  schemas: string[];
  id: string;
  userName: string;
  active: boolean;
  name: { formatted: string };
  emails: { value: string; primary: boolean }[];
  roles?: { value: string }[];
};

export type HubServiceMode = "fast" | "priority" | "flex" | "default" | "";

export type JsonMap = Record<string, unknown>;

type PromptTokenDetails = { cached_tokens: number };

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation_1h_input_tokens?: number;
  prompt_tokens_details?: PromptTokenDetails;
  service_tier?: string;
  speed?: string;
  inference_geo?: string;
  cost?: number;
};
export type PIIConfig = {
  enabled?: boolean | null;
  mode?: string;
  output?: boolean | null;
  entities?: string[];
};

export type JWTConfig = {
  issuer?: string;
  audience?: string;
  jwks_url?: string;
};

export type OIDCConfig = {
  enabled?: boolean;
  issuer?: string;
  client_id?: string;
  redirect_url?: string;
};

export type S3Addressing = "auto" | "path" | "virtual-hosted";

export type S3Settings = {
  enabled?: boolean;
  bucket?: string;
  region?: string;
  endpoint?: string;
  prefix?: string;
  addressing?: S3Addressing;
  public_base_url?: string;
  domain_bucket?: boolean;
};

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type AlertWebhook = {
  id: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
};

export type Enterprise = {
  oidc?: OIDCConfig;
  alert_webhooks?: AlertWebhook[];
  log_retention_days?: number;
  spend_retention_days?: number;
  audit_retention_days?: number;
  object_retention_days?: number;
  file_retention_days?: number;
  cache_ttl_seconds?: number;
  log_archive?: boolean;
  log_content?: boolean;
  content_retention_days?: number;
  pii?: PIIConfig;
  s3?: S3Settings;
  budget_alert_thresholds?: number[];
  registration_enabled?: boolean;
  assistant_model?: string;
  assistant_model_locked?: boolean;
  catalog_jev?: JevSettings;
  catalog_auto_routes?: boolean;
  catalog_min_confidence?: number;
  update_check?: boolean;
};

export type CatalogRouting = {
  autoRoutes: boolean;
  minConfidence: number;
};

export type JevSettings = {
  enabled: boolean;
  model: string;
  api_key: string;
};

export type Deployment = {
  id: string;
  kind: string;
  base_url: string;
  model: string;
  weight: number;
  cost_input_per_1k: number;
  cost_output_per_1k: number;
  provider_id: string;
};

export type ModelGroup = {
  alias: string;
  strategy: string;
  billing_mode: string;
  price_input_per_1k: number;
  price_output_per_1k: number;
  price_time_zone: string;
  price_windows: PriceWindowRates[];
  overflow_group: string;
  num_retries: number;
  fallback_groups: string[];
  deployments: Deployment[];
};
export type VirtualKeyView = {
  token_id: string;
  key?: string;
  key_name: string;
  key_alias: string;
  user_id: string;
  team_id: string;
  org_id: string;
  project_id: string;
  member_id: string;
  models: string[];
  templates: string[];
  max_budget: number;
  spend: number;
  rpm_limit: number;
  tpm_limit: number;
  budget_duration: string;
  expires: string;
  allowed_ips: string[];
  blocked: boolean;
  pii: PiiPolicy | null;
  log_content: boolean;
  created_at: string;
};

export type KeyTenancy = {
  userId: string;
  memberId: string;
  projectId: string;
  teamId: string;
  orgId: string;
};

export type KeyBindingRow = {
  userId: string | null;
  teamId: string | null;
  orgId: string | null;
  projectId: string | null;
  memberId: string | null;
};

export type Principal = {
  actor: string;
  key?: VirtualKeyView;
  teamId: string;
  orgId: string;
  userId: string;
  memberId: string;
  models: string[];
  routeLimits: RouteLimits;
  trace?: RequestTrace;
};

export type ProxyFirstResult = {
  status: number;
  json: unknown;
  raw: Uint8Array;
  contentType: string;
  depId: string;
  alias: string;
  dep: ResolvedDeployment;
  group: ModelGroup & { mapped: ResolvedDeployment[] };
};

export type UsageSlice = {
  day: string;
  keyId: string;
  teamId: string;
  orgId: string;
  projectId: string;
  memberId: string;
  userId: string;
  model: string;
  requests: number;
  errors: number;
  rateLimited: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
  purchaseCost?: number;
};

export type ChargebackParts = {
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  keyId: string;
  userId: string;
  model: string;
};

export type SliceRow = {
  name: string;
  spend: number;
  purchase?: number;
  prompt: number;
  completion: number;
  requests?: number;
  errors?: number;
  rate429?: number;
  latency?: number;
};

export type Bucket = { start: number; rpm: number; tpm: number };

export type RedisLike = {
  incrby(key: string, amount: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
};
