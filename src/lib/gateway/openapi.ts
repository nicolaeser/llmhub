import { gatewayPath } from "@/lib/gateway/route-pool";
import type { OpenApiMethod, OpenApiPath, TryTarget } from "@/types/gateway";

export const ANTHROPIC_VERSION = "2023-06-01";

export const OPENAPI_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
] as const;

function isOpenApiMethod(value: string): value is OpenApiMethod {
  return (OPENAPI_METHODS as readonly string[]).includes(value);
}

export function openApiPathParams(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]!);
}

function fillOpenApiPath(
  path: string,
  params: Record<string, string>,
): string {
  return path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const value = params[name]?.trim() ?? "";
    return value ? encodeURIComponent(value) : `{${name}}`;
  });
}

export function resolveTryTarget(
  method: string,
  templatePath: string,
  params: Record<string, string>,
): TryTarget {
  if (!isOpenApiMethod(method)) return { ok: false, error: "UNKNOWN_ENDPOINT" };
  const spec = OPENAPI_PATHS.find(
    (row) => row.method === method && row.path === templatePath,
  );
  if (!spec || spec.style === "management") return { ok: false, error: "UNKNOWN_ENDPOINT" };
  const filled: Record<string, string> = {};
  for (const name of openApiPathParams(spec.path)) {
    const value = params[name]?.trim() ?? "";
    if (!value) return { ok: false, error: "MISSING_PARAM" };
    filled[name] = value;
  }
  const path = fillOpenApiPath(spec.path, filled);
  if (
    path.includes("{") ||
    !gatewayPath(path).startsWith("/v1/") ||
    path.includes("..") ||
    path.includes("//")
  ) {
    return { ok: false, error: "MISSING_PARAM" };
  }
  return { ok: true, method: spec.method, path };
}

export function exampleRequestBody(
  method: OpenApiMethod,
  path: string,
  model: string,
): string | null {
  if (method === "GET" || method === "DELETE") return null;
  const alias = model.trim() || "my-alias";
  const examples: Record<string, unknown> = {
    "/v1/chat/completions": {
      model: alias,
      messages: [{ role: "user", content: "Hello" }],
      stream: false,
    },
    "/v1/completions": { model: alias, prompt: "Hello", stream: false },
    "/v1/embeddings": { model: alias, input: "Hello" },
    "/v1/rerank": {
      model: alias,
      query: "How do I reset my password?",
      documents: ["Passwords are reset under Account > Security.", "Invoices are sent monthly."],
      top_n: 1,
    },
    "/v1/vector_stores": {
      name: "Support handbook",
      file_ids: ["file_id"],
      embedding_model: alias,
      expires_after: { anchor: "last_active_at", days: 30 },
    },
    "/v1/vector_stores/{id}": { name: "Support handbook", metadata: { team: "support" } },
    "/v1/vector_stores/{id}/search": {
      query: "How do I reset my password?",
      max_num_results: 5,
      filters: { type: "eq", key: "category", value: "faq" },
      ranking_options: { ranker: "auto", score_threshold: 0.2 },
    },
    "/v1/vector_stores/{id}/files": { file_id: "file_id", attributes: { category: "faq" } },
    "/v1/vector_stores/{id}/files/{file_id}": { attributes: { category: "faq", year: 2026 } },
    "/v1/vector_stores/{id}/file_batches": {
      file_ids: ["file_id"],
      chunking_strategy: { type: "static", static: { max_chunk_size_tokens: 800, chunk_overlap_tokens: 400 } },
    },
    "/v1/files": {
      filename: "notes.txt",
      purpose: "assistants",
      content_b64: "",
    },
    "/v1/batches": {
      input_file_id: "file_id",
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
    },
    "/v1/images/generations": { model: alias, prompt: "A red circle" },
    "/v1/images/edits": { model: alias, prompt: "Add a hat" },
    "/v1/images/variations": { model: alias },
    "/v1/audio/speech": {
      model: alias,
      input: "Hello from LLM Hub",
      voice: "alloy",
    },
    "/v1/audio/transcriptions": { model: alias, filename: "audio.wav" },
    "/v1/audio/translations": { model: alias, filename: "audio.wav" },
    "/v1/videos": { model: alias, prompt: "A slow pan across a desk" },
    "/v1/videos/{id}/remix": { prompt: "Make it dusk" },
    "/v1/responses": { model: alias, input: "Hello" },
    "/v1/responses/input_tokens": { model: alias, input: "Hello" },
    "/v1/messages": {
      model: alias,
      max_tokens: 256,
      messages: [{ role: "user", content: "Hello" }],
    },
    "/v1/messages/count_tokens": {
      model: alias,
      messages: [{ role: "user", content: "Hello" }],
    },
    "/v1/systemone": {
      model: alias,
      state: "I was charged twice. Please help.",
      questions: {
        billing: { type: "noul", instructions: "Is this message about billing?" },
        tone: { type: "choice", instructions: "What is the tone?", criteria: { calm: null, angry: null } },
      },
    },
    "/v1/moderations": { model: alias, input: "Hello" },
    "/v1/ocr": { model: alias, image: { url: "https://example.com/image.png" } },
    "/api/keys": { alias: "ci-pipeline", project_id: "project_id", models: [alias], rpm_limit: 60, expires_in_days: 90 },
    "/api/keys/{id}": { blocked: false, rpm_limit: 120 },
    "/api/models": {
      alias: "my-new-alias",
      strategy: "least_inflight",
      deployments: [{ provider_id: "provider_id", model: "upstream-model-id" }],
    },
    "/api/models/{alias}": { num_retries: 2 },
    "/api/providers": { kind: "openai", name: "OpenAI", api_key: "" },
    "/api/providers/{id}": { name: "OpenAI production" },
    "/api/providers/{id}/import": { models: [], strategy: "cost_lowest" },
    "/api/teams": { alias: "IT", org_id: "org_id", rpm_limit: 600 },
    "/api/teams/{id}": { tpm_limit: 200000 },
    "/api/organizations": { alias: "acme" },
    "/api/organizations/{id}": { alias: "acme-eu" },
    "/api/projects": { alias: "chatbot", org_id: "org_id", team_id: "team_id", owner: "ops@example.com" },
    "/api/projects/{id}": { owner: "ops@example.com" },
    "/api/members": { name: "Alex Example", org_id: "org_id", team_id: "team_id", email: "alex@example.com" },
    "/api/members/{id}": { team_id: null, blocked: false },
    "/api/budgets/alerts": { thresholds: [50, 80, 100] },
    "/api/budgets/{entity_type}/{entity_id}": { max_budget: 250, budget_duration: "30d" },
    "/api/budgets/{entity_type}/{entity_id}/temporary": { amount: 50, hours: 24 },
  };
  const value = examples[gatewayPath(path)];
  if (value === undefined) return path.startsWith("/api/") ? null : "{\n  \n}";
  return JSON.stringify(value, null, 2);
}

export const OPENAPI_PATHS: OpenApiPath[] = [
  { method: "POST", path: "/v1/chat/completions", summary: "Create a chat completion", style: "openai" },
  { method: "POST", path: "/v1/completions", summary: "Create a text completion", style: "openai" },
  { method: "POST", path: "/v1/embeddings", summary: "Create embeddings", style: "openai" },
  { method: "POST", path: "/v1/rerank", summary: "Rerank documents by relevance to a query", style: "openai" },
  { method: "GET", path: "/v1/models", summary: "List models", style: "dual" },
  { method: "GET", path: "/v1/models/{id}", summary: "Retrieve a model", style: "dual" },
  { method: "GET", path: "/v1/files", summary: "List files", style: "openai" },
  { method: "POST", path: "/v1/files", summary: "Upload a file", style: "openai" },
  { method: "GET", path: "/v1/files/{id}", summary: "Retrieve a file", style: "openai" },
  { method: "DELETE", path: "/v1/files/{id}", summary: "Delete a file", style: "openai" },
  { method: "GET", path: "/v1/files/{id}/content", summary: "Download file content", style: "openai" },
  { method: "GET", path: "/v1/vector_stores", summary: "List vector stores", style: "openai" },
  { method: "POST", path: "/v1/vector_stores", summary: "Create a vector store", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}", summary: "Retrieve a vector store", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}", summary: "Modify a vector store", style: "openai" },
  { method: "DELETE", path: "/v1/vector_stores/{id}", summary: "Delete a vector store", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}/search", summary: "Search a vector store", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}/files", summary: "List vector store files", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}/files", summary: "Add a file to a vector store", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}/files/{file_id}", summary: "Retrieve a vector store file", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}/files/{file_id}", summary: "Update a vector store file's attributes", style: "openai" },
  { method: "DELETE", path: "/v1/vector_stores/{id}/files/{file_id}", summary: "Remove a file from a vector store", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}/files/{file_id}/content", summary: "Retrieve a vector store file's indexed chunks", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}/file_batches", summary: "Add a batch of files to a vector store", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}/file_batches/{batch_id}", summary: "Retrieve a vector store file batch", style: "openai" },
  { method: "POST", path: "/v1/vector_stores/{id}/file_batches/{batch_id}/cancel", summary: "Cancel a vector store file batch", style: "openai" },
  { method: "GET", path: "/v1/vector_stores/{id}/file_batches/{batch_id}/files", summary: "List files in a vector store file batch", style: "openai" },
  { method: "GET", path: "/v1/batches", summary: "List batches", style: "openai" },
  { method: "POST", path: "/v1/batches", summary: "Create a batch", style: "openai" },
  { method: "GET", path: "/v1/batches/{id}", summary: "Retrieve a batch", style: "openai" },
  { method: "POST", path: "/v1/batches/{id}/cancel", summary: "Cancel a batch", style: "openai" },
  { method: "POST", path: "/v1/images/generations", summary: "Generate images", style: "openai" },
  { method: "POST", path: "/v1/images/edits", summary: "Edit an image", style: "openai" },
  { method: "POST", path: "/v1/images/variations", summary: "Create image variations", style: "openai" },
  { method: "POST", path: "/v1/audio/speech", summary: "Synthesize speech", style: "openai" },
  { method: "POST", path: "/v1/audio/transcriptions", summary: "Transcribe audio", style: "openai" },
  { method: "POST", path: "/v1/audio/translations", summary: "Translate audio into English", style: "openai" },
  { method: "POST", path: "/v1/videos", summary: "Create a video", style: "openai" },
  { method: "GET", path: "/v1/videos/{id}", summary: "Retrieve a video", style: "openai" },
  { method: "DELETE", path: "/v1/videos/{id}", summary: "Delete a video", style: "openai" },
  { method: "GET", path: "/v1/videos/{id}/content", summary: "Download video content", style: "openai" },
  { method: "POST", path: "/v1/videos/{id}/remix", summary: "Remix a video", style: "openai" },
  { method: "GET", path: "/v1/responses", summary: "List responses", style: "openai" },
  { method: "POST", path: "/v1/responses", summary: "Create a response", style: "openai" },
  { method: "GET", path: "/v1/responses/{id}", summary: "Retrieve a response", style: "openai" },
  { method: "DELETE", path: "/v1/responses/{id}", summary: "Delete a response", style: "openai" },
  { method: "GET", path: "/v1/responses/{id}/input_items", summary: "List a response's input items", style: "openai" },
  { method: "POST", path: "/v1/responses/input_tokens", summary: "Count Responses input tokens", style: "openai" },
  { method: "POST", path: "/v1/messages", summary: "Create an Anthropic Messages response", style: "anthropic" },
  { method: "POST", path: "/v1/messages/count_tokens", summary: "Count Anthropic Messages input tokens", style: "anthropic" },
  { method: "POST", path: "/v1/systemone", summary: "Answer typed decision questions (TypeSafe Jev)", style: "openai" },
  { method: "POST", path: "/v1/moderations", summary: "Classify content", style: "openai" },
  { method: "POST", path: "/v1/ocr", summary: "Extract text from images", style: "openai" },
  { method: "POST", path: "/subscription/v1/chat/completions", summary: "Create a chat completion on a subscription", style: "openai" },
  { method: "POST", path: "/subscription/v1/responses", summary: "Create a response on a subscription", style: "openai" },
  { method: "POST", path: "/subscription/v1/messages", summary: "Create an Anthropic Messages response on a subscription", style: "anthropic" },
  { method: "GET", path: "/subscription/v1/models", summary: "List models served by subscriptions", style: "dual" },
  { method: "GET", path: "/subscription/v1/models/{id}", summary: "Retrieve a model served by subscriptions", style: "dual" },
  { method: "GET", path: "/api/me", summary: "Show the key's user and effective permissions", style: "management" },
  { method: "GET", path: "/api/keys", summary: "List API keys", style: "management" },
  { method: "POST", path: "/api/keys", summary: "Create an API key", style: "management" },
  { method: "GET", path: "/api/keys/{id}", summary: "Retrieve an API key", style: "management" },
  { method: "PATCH", path: "/api/keys/{id}", summary: "Update an API key", style: "management" },
  { method: "DELETE", path: "/api/keys/{id}", summary: "Delete an API key", style: "management" },
  { method: "POST", path: "/api/keys/{id}/rotate", summary: "Rotate an API key secret", style: "management" },
  { method: "GET", path: "/api/models", summary: "List model aliases", style: "management" },
  { method: "POST", path: "/api/models", summary: "Create a model alias", style: "management" },
  { method: "GET", path: "/api/models/{alias}", summary: "Retrieve a model alias", style: "management" },
  { method: "PATCH", path: "/api/models/{alias}", summary: "Update a model alias", style: "management" },
  { method: "DELETE", path: "/api/models/{alias}", summary: "Delete a model alias", style: "management" },
  { method: "GET", path: "/api/providers", summary: "List providers", style: "management" },
  { method: "POST", path: "/api/providers", summary: "Connect a provider", style: "management" },
  { method: "GET", path: "/api/providers/{id}", summary: "Retrieve a provider", style: "management" },
  { method: "PATCH", path: "/api/providers/{id}", summary: "Update a provider", style: "management" },
  { method: "DELETE", path: "/api/providers/{id}", summary: "Delete a provider", style: "management" },
  { method: "POST", path: "/api/providers/{id}/discover", summary: "Refresh a provider's model list", style: "management" },
  { method: "POST", path: "/api/providers/{id}/import", summary: "Import provider models as aliases", style: "management" },
  { method: "GET", path: "/api/organizations", summary: "List companies", style: "management" },
  { method: "POST", path: "/api/organizations", summary: "Create a company", style: "management" },
  { method: "GET", path: "/api/organizations/{id}", summary: "Retrieve a company", style: "management" },
  { method: "PATCH", path: "/api/organizations/{id}", summary: "Rename a company", style: "management" },
  { method: "DELETE", path: "/api/organizations/{id}", summary: "Delete a company", style: "management" },
  { method: "GET", path: "/api/teams", summary: "List departments", style: "management" },
  { method: "POST", path: "/api/teams", summary: "Create a department", style: "management" },
  { method: "GET", path: "/api/teams/{id}", summary: "Retrieve a department", style: "management" },
  { method: "PATCH", path: "/api/teams/{id}", summary: "Update a department", style: "management" },
  { method: "DELETE", path: "/api/teams/{id}", summary: "Delete a department", style: "management" },
  { method: "GET", path: "/api/members", summary: "List people of companies", style: "management" },
  { method: "POST", path: "/api/members", summary: "Add a person to a company", style: "management" },
  { method: "GET", path: "/api/members/{id}", summary: "Retrieve a person", style: "management" },
  { method: "PATCH", path: "/api/members/{id}", summary: "Update a person", style: "management" },
  { method: "DELETE", path: "/api/members/{id}", summary: "Delete a person and revoke their keys", style: "management" },
  { method: "GET", path: "/api/projects", summary: "List projects", style: "management" },
  { method: "POST", path: "/api/projects", summary: "Create a project", style: "management" },
  { method: "GET", path: "/api/projects/{id}", summary: "Retrieve a project", style: "management" },
  { method: "PATCH", path: "/api/projects/{id}", summary: "Update a project", style: "management" },
  { method: "DELETE", path: "/api/projects/{id}", summary: "Delete a project and revoke its keys", style: "management" },
  { method: "GET", path: "/api/budgets", summary: "List budgets", style: "management" },
  { method: "PUT", path: "/api/budgets/alerts", summary: "Set budget alert thresholds", style: "management" },
  { method: "PUT", path: "/api/budgets/{entity_type}/{entity_id}", summary: "Set a budget", style: "management" },
  { method: "POST", path: "/api/budgets/{entity_type}/{entity_id}/temporary", summary: "Add a temporary budget", style: "management" },
  { method: "GET", path: "/api/usage", summary: "Summarize usage and spend", style: "management" },
  { method: "GET", path: "/api/logs/requests", summary: "List request logs", style: "management" },
  { method: "GET", path: "/api/logs/spend", summary: "List spend events", style: "management" },
  { method: "GET", path: "/api/logs/audit", summary: "List audit events", style: "management" },
];
