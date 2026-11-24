import type { AssignmentScope, AssignmentSource } from "@/types/providers";
import type { JsonMap, Principal } from "@/types/gateway";
import type { OutputGuard } from "@/types/guardrails";

export type McpStaticAuthType = "none" | "bearer" | "basic" | "header" | "query";

export type McpAuthType = McpStaticAuthType | "oauth";

export type McpOAuthGrant = "authorization_code" | "client_credentials";

export type McpTransport = "streamable_http" | "sse";

export type McpEra = "modern" | "legacy" | "sse";

export type McpAccessLevel = "none" | "read" | "write" | "all";

export type McpRuleAccess = McpAccessLevel | "inherit";

export type McpServerStatus = "connected" | "error" | "disabled" | "unchecked" | "signin";

export type McpChallenge = {
  resourceMetadata: string;
  scope: string;
  error: string;
};

export type McpAuth = {
  headers(signal?: AbortSignal): Promise<Record<string, string>>;
  rejected(challenge: McpChallenge | null, signal?: AbortSignal): Promise<boolean>;
};

export type McpConnection = {
  transport: McpTransport;
  protocolVersion: string;
};

export type McpHeaderParam = {
  path: string[];
  header: string;
};

export type McpToolAction = "read" | "write" | "delete";

export type McpServerKind = "remote" | "hosted" | "media";

export type McpMediaKind = "image" | "speech" | "video" | "transcription";

export type McpMediaSpec = {
  image: { model: string };
  speech: { model: string; voice: string };
  video: { model: string };
  transcription: { model: string };
};

export type McpToolSpec = {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonMap;
  action?: McpToolAction;
  hint?: McpToolAction;
};

export type McpToolActions = Record<string, McpToolAction>;

export type HostedTool = {
  name: string;
  title: string;
  description: string;
  action: McpToolAction;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query: string[];
  inputSchema: JsonMap;
};

export type HostedSpec = {
  tools: HostedTool[];
};

export type McpBuilderTemplate = "readonly" | "writes" | "full" | "custom";

export type McpDraftServer = {
  name: string;
  description: string;
  baseUrl: string;
  internal: boolean;
  authType: McpStaticAuthType;
  authHeader: string;
  notes: string;
};

export type McpDraftReading = {
  server: McpDraftServer | null;
  tools: HostedTool[];
  cut: boolean;
};

export type McpOpenApiImport = {
  server: McpDraftServer;
  tools: HostedTool[];
  operations: number;
};

export type McpDocsAuthType = "none" | "bearer" | "basic" | "header" | "query" | "cookie";

export type McpDocsAuth = {
  type: McpDocsAuthType;
  name: string;
  secret: string;
};

export type McpDocsLink = {
  url: string;
  internal: boolean;
  crawl: boolean;
  auth: McpDocsAuthType;
  name: string;
  secret: string;
};

export type McpDocsCookie = {
  name: string;
  value: string;
  path: string;
  secure: boolean;
};

export type McpDocsJar = Map<string, McpDocsCookie>;

export type McpDocsSession = {
  start: URL;
  fetchImpl: McpFetch;
  auth: McpDocsAuth;
  jar: McpDocsJar;
  signal?: AbortSignal;
};

export type McpDocsResponse = {
  url: URL;
  requested: URL;
  redirected: boolean;
  contentType: string;
  bytes: Uint8Array;
};

export type McpDocsPage = {
  url: string;
  title: string;
  text: string;
};

export type McpCrawlLimit = "depth" | "pages" | "bytes" | "time";

export type McpCrawlStats = {
  pages: number;
  skipped: number;
  failed: number;
  truncated: McpCrawlLimit | null;
};

export type McpCrawlBudget = {
  pages: number;
  bytes: number;
  fetches: number;
  deadline: number;
};

export type McpCrawlSummary = McpCrawlStats & {
  link: number;
  url: string;
};

export type McpDocsSpec = {
  url: string;
  text: string;
};

export type McpDocsSite = {
  link: number;
  session: McpDocsSession;
  scopes: string[];
  pages: McpDocsPage[];
  specs: McpDocsSpec[];
  stats: McpCrawlStats;
  budget: McpCrawlBudget;
  seen: Set<string>;
  texts: Set<string>;
};

export type McpDocsCrawl = {
  first: McpDocsResponse;
  site: McpDocsSite | null;
};

export type McpDocsFetched = { page: McpDocsPage } | { error: string };

export type McpDocsLinkRow = McpDocsLink & { key: string };

export type McpDocsFileRow = { key: string; file: File };

export type McpLinkedDocument = {
  url: string;
  contentType: string;
  bytes: Uint8Array;
};

export type McpBuilderUpload = {
  name: string;
  type: string;
  bytes: Uint8Array;
};

export type McpDocsSourceKind = "link" | "text" | "file";

export type McpDocsSourceRef = {
  kind: McpDocsSourceKind;
  name: string;
};

export type McpDocsSource =
  | { ref: McpDocsSourceRef; text: string; link: string; pages: McpDocsPage[] }
  | { ref: McpDocsSourceRef; part: JsonMap };

export type McpBuilderSection = {
  label: string;
  pages: McpDocsPage[];
};

export type McpBuilderLibrary = {
  sections: McpBuilderSection[];
  attachments: JsonMap[];
  fetchPage: ((url: string) => Promise<McpDocsFetched>) | null;
};

export type McpBuilderTurn = {
  message: JsonMap;
  text: string;
  cut: boolean;
  calls: McpToolCall[];
  toolsAccepted: boolean;
};

export type McpBuilderComplete = (messages: JsonMap[], tools: JsonMap[] | null) => Promise<McpBuilderTurn>;

export type McpBuilderResult = {
  server: McpDraftServer;
  tools: HostedTool[];
  passes: number;
  parts: number;
};

export type McpDocsLogin = {
  link: number;
  authType: Exclude<McpStaticAuthType, "none">;
  authHeader: string;
  secret: string;
};

export type McpApiAddress = { given?: string; hinted?: string };

export type McpDraft = McpDraftServer & {
  tools: HostedTool[];
  included: string[];
  source: "openapi" | "model";
  operations: number;
  importedFrom: McpDocsSourceRef | null;
  unused: McpDocsSourceRef[];
  crawls: McpCrawlSummary[];
  passes: number;
  parts: number;
};

export type McpMediaModel = {
  alias: string;
  label: string;
  media: boolean;
};

export type McpBuilderModel = {
  alias: string;
  label: string;
  internal: boolean;
};

export type McpServerRecord = {
  id: string;
  name: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  authSecret: string;
  internal: boolean;
  oauthGrant: McpOAuthGrant;
  oauthClientId: string;
  oauthScopes: string;
  transport: McpTransport;
  protocolVersion: string;
  kind: McpServerKind;
  spec: HostedSpec;
  media: McpMediaSpec;
};

export type McpAccessGrant = {
  access: McpRuleAccess;
  extraTools: string[];
  blockedTools: string[];
};

export type McpInstallationView = {
  id: string;
  orgId: string;
  orgLabel: string;
  enabled: boolean;
  baseUrl: string;
  authType: McpStaticAuthType;
  authHeader: string;
  hasSecret: boolean;
};

export type McpAssignmentRule = {
  serverId: string;
  orgId: string | null;
  teamId: string | null;
  projectId: string | null;
  memberId: string | null;
  keyId: string | null;
} & McpAccessGrant;

export type McpChain = {
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
  keyId: string;
};

export type McpServerPolicy = {
  id: string;
  name: string;
  defaultAccess: McpAccessLevel;
  enabled: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
  tools: McpToolSpec[];
};

export type McpEffectiveServer = {
  serverId: string;
  serverName: string;
  tools: McpToolSpec[];
};

export type McpBoundTool = {
  name: string;
  serverId: string;
  serverName: string;
  tool: McpToolSpec;
};

export type McpHostedAuth = {
  headers: Record<string, string>;
  query: Record<string, string>;
};

export type McpToolOutcome = {
  text: string;
  isError: boolean;
};

export type McpToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type McpExecutor = {
  call(bound: McpBoundTool, args: JsonMap, signal: AbortSignal): Promise<McpToolOutcome>;
  close(): Promise<void>;
};

export type McpToolset = {
  tools: McpBoundTool[];
  byName: Map<string, McpBoundTool>;
  executor: McpExecutor;
};

export type McpFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal },
) => Promise<Response>;

export type McpSseEvent = {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
};

export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type McpServerView = {
  id: string;
  name: string;
  description: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  hasSecret: boolean;
  oauthGrant: McpOAuthGrant;
  oauthClientId: string;
  oauthScopes: string;
  oauth: McpOAuthView | null;
  internal: boolean;
  kind: McpServerKind;
  media: McpMediaSpec | null;
  enabled: boolean;
  global: boolean;
  defaultAccess: McpAccessLevel;
  template: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
  tools: McpToolSpec[];
  toolActions: McpToolActions;
  installations: McpInstallationView[];
  transport: McpTransport;
  protocolVersion: string;
  era: McpEra | null;
  refreshedAt: string | null;
  lastError: string;
  status: McpServerStatus;
  assignments: McpAssignmentView[];
  updatedAt: string;
};

export type McpOAuthView = {
  status: "active" | "expired";
  scope: string;
  expiresAt: string | null;
  connectedAt: string;
};

export type McpAssignmentView = {
  scope: AssignmentScope;
  id: string;
  label: string;
} & McpAccessGrant;

export type McpAssignmentInput = {
  scope: AssignmentScope;
  id: string;
} & McpAccessGrant;

export type McpTargetOption = {
  id: string;
  label: string;
  detail: string;
  orgId: string;
  teamId: string;
  projectId: string;
  memberId: string;
};

export type McpTargetOptions = Record<AssignmentScope, McpTargetOption[]>;

export type McpServerInput = {
  name: string;
  description: string;
  url: string;
  authType: McpAuthType;
  authHeader: string;
  secret: string;
  clearSecret: boolean;
  oauthGrant: McpOAuthGrant;
  oauthClientId: string;
  oauthScopes: string;
  internal: boolean;
  enabled: boolean;
  toolsRestricted: boolean;
  allowedTools: string[];
};

export type McpProbeResult = {
  connected: boolean;
  tools: McpToolSpec[];
  serverName: string;
  error: string;
  transport: McpTransport | null;
  protocolVersion: string;
  era: McpEra | null;
};

export type McpAccessSource = { kind: "default" } | { kind: "rule"; rule: McpAssignmentView };

export type McpCeiling = {
  level: McpAccessLevel | null;
  limitedBy: McpAccessSource | null;
  allows: (tool: Pick<McpToolSpec, "name">) => boolean;
};

export type McpExplanation = {
  state: "granted" | "blocked" | "none";
  level: McpAccessLevel;
  limitedBy: McpAccessSource | null;
  steps: McpAssignmentView[];
  usesDefault: boolean;
  tools: string[];
};

export type McpLoopLimits = {
  maxSteps: number;
  deadline: number;
};

export type McpUrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; code: "MCP_URL_INVALID" | "MCP_URL_INSECURE" | "MCP_URL_BLOCKED" };

export type McpLoopContext = {
  principal: Principal;
  model: string;
  aliases: string[];
  outputGuard: OutputGuard | null;
  toolset: McpToolset;
  maxCost: number | null;
  signal?: AbortSignal;
};

export type McpCallRecord = {
  call: McpToolCall;
  bound: McpBoundTool;
  outcome: McpToolOutcome;
  content: string;
};

export type McpChatStep = {
  message: JsonMap;
  calls: McpCallRecord[];
};

export type McpChatRun = {
  final: JsonMap;
  transcript: JsonMap[];
  steps: McpChatStep[];
};

export type McpStreamSink = {
  start(): string[];
  chunk(chunk: JsonMap): string[];
  toolStart(call: McpToolCall, bound: McpBoundTool): { index: number; events: string[] };
  toolEnd(index: number, record: McpCallRecord): string[];
  finish(): string[];
  fail(message: string): string[];
  done(transcript: JsonMap[]): Promise<void>;
};

export type McpStreamSlot = {
  id: string;
  name: string;
  arguments: string;
  kind: "pending" | "mcp" | "caller";
  out: number;
  held: JsonMap[];
};

export type McpMessagesBlock = {
  block: JsonMap;
  mcp: boolean;
  out: number;
  json: string;
};

export type McpAssignmentSource = AssignmentSource & {
  access: string;
  extraTools: string[];
  blockedTools: string[];
};

export type McpTokenAuthMethod = "none" | "client_secret_basic" | "client_secret_post";

export type McpOAuthClient = {
  clientId: string;
  clientSecret: string;
  authMethod: McpTokenAuthMethod;
  registration: "manual" | "metadata" | "dynamic";
  redirectUri: string;
};

export type McpResourceMetadata = {
  resource: string;
  authorizationServers: string[];
  scopesSupported: string[];
};

export type McpAuthServer = {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopesSupported: string[];
  codeChallengeMethods: string[];
  tokenAuthMethods: string[];
  clientMetadataDocuments: boolean;
  issParameter: boolean;
};

export type McpOAuthDiscovery = {
  resource: string;
  scope: string;
  server: McpAuthServer;
};

export type McpTokenGrant = {
  access: string;
  refresh: string;
  scope: string;
  expiresAt: Date | null;
};

export type McpOAuthPending = {
  serverId: string;
  userId: string;
  url: string;
  state: string;
  verifier: string;
  issuer: string;
  issParameter: boolean;
  tokenEndpoint: string;
  resource: string;
  scope: string;
  client: McpOAuthClient;
  issuedAt: number;
};

export type McpOAuthLoginState = {
  issuer: string;
  tokenEndpoint: string;
  resource: string;
  client: McpOAuthClient;
  tokens: { access: string; refresh: string };
  scope: string;
  expiresAt: number | null;
  version: number;
};

export type McpKeyServerAccess = {
  serverId: string;
  name: string;
  description: string;
  kind: McpServerKind;
  enabled: boolean;
  template: boolean;
  connected: boolean;
  defaultAccess: McpAccessLevel;
  toolsRestricted: boolean;
  allowedTools: string[];
  tools: McpToolSpec[];
  inherited: McpAssignmentView[];
  rule: McpAssignmentView | null;
};

export type McpKeyAccess = {
  keyId: string;
  label: string;
  company: string;
  chain: McpChain;
  servers: McpKeyServerAccess[];
};

export type McpKeyAccessChoice = { serverId: string } & McpAccessGrant;

export type McpCompanyServers = {
  company: { id: string; alias: string };
  servers: McpServerView[];
  canInstall: boolean;
};
