import type { AssistantPage, AssistantTopic } from "@/types/assistant";

export const ASSISTANT_PAGES = {
  keys: "/keys",
  playground: "/playground",
  assistant: "/assistant",
  providers: "/providers",
  models: "/models",
  "model-templates": "/model-templates",
  "model-catalog": "/model-catalog",
  catalog: "/model-catalog",
  guardrails: "/guardrails",
  usage: "/usage",
  "what-if": "/what-if",
  logs: "/logs",
  "provider-health": "/provider-health",
  companies: "/companies",
  structure: "/companies",
  organizations: "/companies",
  departments: "/companies",
  teams: "/companies",
  projects: "/companies",
  people: "/companies",
  members: "/companies",
  users: "/users",
  budgets: "/companies",
  "api-ref": "/api-ref",
  cache: "/cache",
  router: "/models",
  logging: "/logging",
  roles: "/roles",
  "admin-settings": "/admin-settings",
  account: "/account",
} as const satisfies Record<string, string>;

export const ASSISTANT_EXPLAIN = {
  setup:
    "Connect one provider with an API key, add a public model alias that points at that provider, then create a virtual key. Clients call /v1 with Authorization: Bearer and that key. Playground tests the same path as a signed-in operator.",
  tenancy:
    "Customers live on the Companies page. A company is the tenant. Inside it, departments carry shared budgets and RPM and TPM limits (for example IT at most 5000 per month). Projects belong to a company and optionally to a department; people are the company's own users, not console users, and also optionally sit in a department. Every customer API key belongs to exactly one project (a project key) or one person (a personal key), so spend rolls up to the department and the company. Console users are separate: platform users see every company, and a console user assigned to a company only sees and manages that company.",
  keys:
    "API keys are hashed Bearer credentials for /v1. The full secret is shown once in the console. A key belongs to a project or a person of a company, or is an internal key of the console user who created it; binding a key to a project or person needs tenancy:manage. Keys can be limited to models or model templates, client IPs, RPM, and TPM, and can be blocked or rotated. Rotation keeps the previous secret valid for one hour.",
  templates:
    "Model templates are reusable model allowlists for API keys. A template combines rules (provider connections, name patterns such as claude-*, zero data retention, maximum provider data retention, data region, no training on prompts) with always-included models. Rules are evaluated on every request, so new matching models are allowed automatically. A model qualifies when at least one endpoint behind it, also through fallback and overflow aliases, meets every rule, and requests from that key are routed only to endpoints that meet the rules. Data policy is set per provider connection on the Providers page.",
  providers:
    "A provider connection stores the upstream kind, base URL, sealed API key, and data policy (zero data retention, retention days, region, no training). OpenAI, Anthropic, OpenRouter, xAI, and any OpenAI-compatible server are supported. Model lists refresh every two hours with the model catalog and on demand.",
  catalog:
    "The model catalog groups every provider model into public aliases. Models with the same name, also spelled differently (dots or dashes, vendor prefixes, date snapshots), share one alias; with Jev set up in Admin settings on its own OpenRouter key, Jev also groups models that providers name differently. The catalog is cached and refreshes every two hours or with Refresh now. A whole model can be turned on or off for every key, and single providers inside it can be turned on or off; aliases keep their names across refreshes. Aliases with Add new providers automatically route trusted providers that start offering the model. Own OpenAI-compatible servers are always turned on by hand.",
  models:
    "A model alias is the public name clients send as model. Aliases are case-insensitive and stored in lowercase; upstream model ids keep their exact case. It load-balances across deployments on connected providers. A disabled alias is hidden from /v1/models and answers model_not_found, also as a fallback or overflow target; its configuration is kept.",
  v1: "OpenAI-compatible API is at /v1 on this origin. Point the OpenAI SDK baseURL at origin/v1 and use a virtual key. Anthropic Messages is at /v1/messages.",
  playground:
    "Playground streams chat through the gateway as the signed-in operator. It does not need a virtual key. A model alias must exist.",
  budgets:
    "Budgets cap spend on a company, department, project, person, console user, or key and are managed on the Companies page (key budgets also on API keys). Every request is checked against the whole chain: key, its person or project, department, and company; internal keys and the playground check the console user and their company. A child budget cannot exceed its parent. When any cap is reached, further /v1 calls are blocked until the period resets, the cap is raised, or a temporary boost is added. Boosts last at most 720 hours and need a capped holder.",
  guardrails:
    "Guardrails are a gateway-wide PII policy that masks or blocks matches in prompts before they reach the upstream model and can redact model output. A company or a single API key can override it with its own mode, output setting, and entity list; a key override wins over its company.",
  cache:
    "The response cache answers identical non-streaming chat requests from the same key for the configured TTL. With REDIS_URL all app instances share it in Redis; otherwise each process keeps its own memory cache. Optional semantic matching also answers when only the last user message differs and its embedding is at least as similar as the threshold; the embedding call is billed to the calling key and only runs for keys allowed to use the embedding model. The Response cache page shows hit rate and net savings for operators with spend:read-all; provider prompt caching is separate and not counted there. Configure it under Response cache.",
  router:
    "Each model alias has a routing strategy (least_inflight, weighted_random, cost_lowest, priority, fast), retries, fallback aliases, and an overflow alias used when no deployment is healthy. Deployments are the upstream endpoints behind that alias and cool down only on retryable failures. Provider health shows each deployment's recent error rate, p50 and p95 latency, and cooldowns, shared across instances when Redis is configured.",
  logging:
    "Request logs record metadata, usage powers the charts, and alert webhooks fire for the events each one subscribes to: upstream exhaustion, budget thresholds, and provider model changes. Retention and S3 archiving are configured under Logging & alerts. Prompt and response content is logged unless switched off globally, per key, per person, or per console user.",
  usage:
    "Usage is spend and request volume. Export CSV or JSONL from the usage and logs screens. Without spend:read-all an operator only sees their own internal keys and playground use; console users assigned to a company only see that company.",
  roles:
    "Roles are editable permission bundles. Built-in templates are admin, operator, finance, and viewer; custom roles combine permissions per area. Each role also decides which assistant tools its members may use. Nobody can grant permissions they do not hold, and the owner always has full access. Every sign-in needs a second factor: an authenticator app, a recovery code, or a passkey.",
  sso:
    "OIDC single sign-on is configured in Settings (client secret in OIDC_CLIENT_SECRET). SCIM provisioning is /scim/v2/Users with the SCIM token from Settings. The owner always signs in locally.",
  assistant:
    "The assistant runs on a gateway model alias and is billed like any request. Admin settings choose the default model and can enforce it so nobody picks another one. Roles decide which assistant tools are available. Write tools only run while Write access is switched on above the chat, and every tool still checks the operator's own permissions.",
  management_keys:
    "Management keys are personal credentials for the /api management API. They are created on the account page with a second-factor code, carry a subset of the owner's permissions (never users, roles, settings, or tools), and are shown once.",
  security:
    "Every account needs a second factor: an authenticator app, recovery codes, or passkeys. Sessions expire after 7 idle days or 30 days. Replacing the authenticator, adding passkeys, or resetting another user's second factor requires a fresh step-up code.",
  costs:
    "Spend is computed from each deployment's input and output price per 1K tokens, or from the provider's reported cost on OpenRouter. A model alias with the custom price billing mode bills its own input and output price per 1K tokens instead, whatever endpoint served the request. Cache writes and reads, service tiers such as priority or flex, and fast mode change the price according to what the provider reports it served.",
} as const satisfies Record<string, string>;

export const assistantPages = Object.keys(ASSISTANT_PAGES) as AssistantPage[];

export const assistantTopics = Object.keys(ASSISTANT_EXPLAIN) as AssistantTopic[];
