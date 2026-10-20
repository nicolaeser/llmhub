export const INTEGRATION_STATUSES = [
  "draft",
  "configured",
  "validated",
  "reviewed",
  "published",
  "deprecated",
] as const;

export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const INTEGRATION_VISIBILITIES = ["all", "selected", "internal", "disabled", "deprecated"] as const;

export type IntegrationVisibility = (typeof INTEGRATION_VISIBILITIES)[number];

export const INTEGRATION_PROTOCOLS = ["rest", "graphql", "soap", "grpc", "webhook", "other"] as const;

export type IntegrationProtocol = (typeof INTEGRATION_PROTOCOLS)[number];

export const SPEC_KINDS = ["openapi", "postman", "graphql", "manual", "json_schema", "unknown"] as const;

export type SpecKind = (typeof SPEC_KINDS)[number];

export const AUTH_METHODS = [
  "none",
  "api_key",
  "bearer",
  "oauth2",
  "basic",
  "header",
  "service_account",
  "custom",
] as const;

export type AuthMethod = (typeof AUTH_METHODS)[number];

export const SIDE_EFFECTS = ["read", "write", "destructive", "sensitive"] as const;

export type SideEffect = (typeof SIDE_EFFECTS)[number];

export const POLICY_SCOPES = [
  "platform",
  "company",
  "integration",
  "connection",
  "tool",
  "agent",
] as const;

export type PolicyScopeName = (typeof POLICY_SCOPES)[number];

export const NODE_TYPES = [
  "validate",
  "permission",
  "request",
  "transform",
  "condition",
  "loop",
  "output",
  "approval",
  "error",
  "rate_limit",
  "model",
] as const;

export type WorkflowNodeType = (typeof NODE_TYPES)[number];

export type JsonSchema = Record<string, unknown>;

export type EndpointParameter = {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  schema: JsonSchema;
};

export type EndpointDraft = {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  parameters: EndpointParameter[];
  headers: Record<string, string>;
  requestSchema: JsonSchema;
  responseSchema: JsonSchema;
  authRequired: boolean;
  errors: { status: string; description: string }[];
  rateLimit: { rpm?: number } | null;
  sideEffect: SideEffect;
  enabled: boolean;
  origin: "global" | "override" | "local";
  protocolExtras: Record<string, unknown>;
};

export type IngestResult = {
  kind: SpecKind;
  protocol: IntegrationProtocol;
  name: string;
  description: string;
  baseUrl: string;
  authMethods: AuthMethod[];
  endpoints: EndpointDraft[];
  limitations: string[];
};

export type PolicyRule = {
  effect: "allow" | "deny";
  tools?: string[];
  operations?: string[];
  effects?: SideEffect[];
  resources?: string[];
  parameters?: Record<string, { enum?: string[]; pattern?: string; maxLength?: number }>;
  denyFields?: string[];
  quotaRpm?: number;
  approval?: boolean;
  environments?: string[];
  notBefore?: string;
  notAfter?: string;
};

export type PolicyContext = {
  tool: string;
  operation: string;
  sideEffect: SideEffect;
  resource: string;
  parameters: Record<string, unknown>;
  environment: string;
  now: Date;
};

export type PolicyDecision = {
  decision: "allow" | "deny";
  approval: boolean;
  reason: string;
  matched: "deny" | "allow" | "default";
  denyFields: string[];
  quotaRpm: number | null;
  policyVersion: number;
};

export type WorkflowNode = {
  id: string;
  type: WorkflowNodeType;
  next?: string;
  schema?: JsonSchema;
  operation?: string;
  method?: string;
  path?: string;
  endpointId?: string;
  body?: unknown;
  assignments?: { target: string; from?: string; const?: unknown; template?: string }[];
  when?: { path: string; equals?: unknown; exists?: boolean };
  then?: string;
  else?: string;
  source?: string;
  item?: string;
  steps?: string[];
  max?: number;
  map?: Record<string, string>;
  prompt?: string;
  try?: string;
  fallback?: unknown;
  rpm?: number;
  enabled?: boolean;
};

export type WorkflowGraph = {
  nodes: WorkflowNode[];
  start: string;
};

export type ExecutionPolicy = {
  timeoutMs: number;
  maxRetries: number;
  maxResponseBytes: number;
  requiresApproval: boolean;
  environment: string;
};

export type StepRecord = {
  id: string;
  type: WorkflowNodeType;
  ok: boolean;
  skipped?: boolean;
  status?: number;
  operation?: string;
  error?: string;
  output?: unknown;
};

export type WorkflowResult = {
  status: "succeeded" | "failed" | "denied" | "approval_required";
  output: unknown;
  steps: StepRecord[];
  error: string;
  operation: string;
  decision: PolicyDecision | null;
};

export type CheckResult = {
  name: string;
  ran: boolean;
  ok: boolean;
  detail: string;
};

export type AgentDraftTool = {
  slug: string;
  name: string;
  description: string;
  kind: "operation" | "workflow";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  graph: WorkflowGraph;
  executionPolicy: ExecutionPolicy;
  operationIds: string[];
};

export type AgentTurn = {
  state: "proposed";
  created: boolean;
  integrationId: string;
  scope: "global" | "company";
  reused: { id: string; name: string; scope: "global" | "company" } | null;
  assumptions: string[];
  limitations: string[];
  explanation: string;
  checks: CheckResult[];
  endpoints: EndpointDraft[];
  tools: AgentDraftTool[];
  rules: PolicyRule[];
  modelCalled: false;
};

export type BlueprintView = {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: IntegrationVisibility;
  protocol: IntegrationProtocol;
  specKind: SpecKind;
  baseUrl: string;
  status: IntegrationStatus;
  version: number;
  authMethods: AuthMethod[];
  limitations: string[];
  audience: string[];
  endpointCount: number;
  toolCount: number;
};

export type CompanyIntegrationView = {
  id: string;
  orgId: string;
  orgAlias: string;
  blueprintId: string;
  blueprintName: string;
  slug: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  version: number;
  endpointCount: number;
  toolCount: number;
  connectionCount: number;
};

export type EndpointView = EndpointDraft & {
  id: string;
  blueprintId: string;
  companyIntegrationId: string;
};

export type ToolView = {
  id: string;
  blueprintId: string;
  companyIntegrationId: string;
  slug: string;
  name: string;
  description: string;
  status: IntegrationStatus;
  version: number;
  publishedVersion: number;
  kind: "operation" | "workflow";
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  executionPolicy: ExecutionPolicy;
  graph: WorkflowGraph;
  origin: string;
  rollbackVersions: number[];
};

export type ConnectionView = {
  id: string;
  orgId: string;
  companyIntegrationId: string;
  integrationName: string;
  name: string;
  authMethod: AuthMethod;
  baseUrl: string;
  internal: boolean;
  status: string;
  healthError: string;
  providerScopes: string[];
  hasSecret: boolean;
  revoked: boolean;
  expiresAt: string;
  label: string;
};

export type AgentView = {
  id: string;
  orgId: string;
  slug: string;
  name: string;
  description: string;
};

export type BindingView = {
  id: string;
  orgId: string;
  agentId: string;
  agentName: string;
  connectionId: string;
  connectionName: string;
  toolId: string;
  toolName: string;
  policyId: string;
  status: string;
};

export type PolicyView = {
  id: string;
  orgId: string;
  scope: PolicyScopeName;
  blueprintId: string;
  companyIntegrationId: string;
  toolId: string;
  agentId: string;
  version: number;
  rules: PolicyRule[];
};

export type ApprovalView = {
  id: string;
  orgId: string;
  kind: string;
  subjectType: string;
  subjectId: string;
  status: string;
  requestedBy: string;
  decidedBy: string;
  reason: string;
  createdAt: string;
};

export type ExecutionView = {
  id: string;
  orgId: string;
  toolId: string;
  toolVersion: number;
  agentId: string;
  actor: string;
  correlationId: string;
  decision: string;
  policyVersion: number;
  status: string;
  operation: string;
  startedAt: string;
  durationMs: number;
  error: string;
};

export type ToolRun = {
  status: string;
  output: unknown;
  error: string;
  operation: string;
  decision: string;
  policyVersion: number;
};

export type EffectivePreview = {
  agentId: string;
  toolId: string;
  decision: PolicyDecision;
  providerNote: string;
  layers: { name: string; version: number; rules: number }[];
};

export type IntegrationStats = {
  published: number;
  denied: number;
  failed: number;
  pendingApprovals: number;
  healthy: number;
};

export type IntegrationPage = {
  canManage: boolean;
  canPublish: boolean;
  canCredentials: boolean;
  platform: boolean;
  orgId: string;
  companies: { id: string; alias: string }[];
  blueprints: BlueprintView[];
  integrations: CompanyIntegrationView[];
  endpoints: EndpointView[];
  tools: ToolView[];
  connections: ConnectionView[];
  agents: AgentView[];
  bindings: BindingView[];
  policies: PolicyView[];
  approvals: ApprovalView[];
  executions: ExecutionView[];
  stats: IntegrationStats;
};

export type SecretEnvelope = {
  accessToken?: string;
  refreshToken?: string;
  clientSecret?: string;
  verifier?: string;
  password?: string;
  apiKey?: string;
};

export type CredentialMetadata = {
  headerName?: string;
  tokenUrl?: string;
  authorizeUrl?: string;
  clientId?: string;
  scopes?: string[];
  state?: string;
};
