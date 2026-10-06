---
type: instruction
description: Load when changing public, management, internal, or OpenAI-compatible HTTP routes or their errors.
scope: repository
---

# API

Load before changing `src/app/v1/`, `src/app/api/`, `src/app/internal-api/`, `src/app/sso/`, `src/app/scim/`, health, metrics, or error responses.

## Mandatory rules

- OpenAI-compatible paths live at `/v1/*`, not `/api/v1`. Each endpoint is a `route.ts` that uses shared gateway helpers. Do not revive a barrel of handlers.
- `/v1` authenticates bearer tokens only through `authenticateBearer` (`src/lib/gateway/principal.ts`): virtual key, then playground try-token; management keys are rejected first. There is no master key, JWT, or custom-auth webhook; every caller is bound by model access, budgets, and rate limits. `verifyJwt` (`src/lib/gateway/jwks.ts`) only verifies OIDC ID tokens for console SSO.
- `/v1` covers chat, completions, messages (Anthropic, plus `count_tokens`), responses (plus `input_items` and `input_tokens`), embeddings, moderations, OCR, audio, images, videos, files, batches (create, list, retrieve, cancel), models, and `systemone` (TypeSafe Jev decisions). Every verb forwards to a real upstream deployment; unknown aliases answer 404 and missing upstream endpoints pass the upstream error through.
- Responses and Messages convert through Chat Completions, except `/v1/messages` and `count_tokens` on `anthropic` deployments, which send the native body with the caller's `anthropic-version` and `anthropic-beta`. Messages features with no chat equivalent (server tools, server tool blocks, `file`/`url`/`content` sources) answer 400 on other kinds. Token counting crosses over: `count_tokens` uses `/responses/input_tokens` on other kinds, and `/v1/responses/input_tokens` uses `count_tokens` on `anthropic`.
- Reasoning: chat `reasoning_effort` maps to adaptive thinking plus `output_config.effort` on Claude 4.6+ (`xhigh` becomes `high` before 4.7) and to `budget_tokens` on 4.5 and earlier. On xAI grok 4.5+ it is clamped to `low`–`high` (`xhigh` from 4.6). Claude thinking returns as `reasoning_content` plus signed `thinking_blocks`, which callers send back on assistant messages. Responses emit `reasoning` items whose `encrypted_content` carries the signed blocks and is shown only with `include: ["reasoning.encrypted_content"]`. PII redaction never edits signed thinking.
- Structured outputs map `response_format` `json_schema` to Anthropic `output_config.format` and back; `strict` tools pass both ways.
- Image generations and edits and audio transcriptions relay upstream SSE when `stream` is set and meter the event that carries `usage`.
- Batches run on the in-process worker: `validating`, `in_progress`, then `completed`, `expired`, or `cancelled`, with OpenAI-format output and error JSONL files. Supported endpoints are chat, responses, completions, embeddings, moderations, and image generations.
- Gateway `file_id`s from `/v1/files` inline as data URLs in Responses `input_image`/`input_file`, chat `file` parts, and JSON image edits (`images`, `mask`).
- `/v1/systemone` mirrors the TypeSafe HTTP API (`state`, typed `questions`, probabilities in `answers`), has no streaming, and meters `usage.input_tokens`.
- `fallbacks`, `fallback`, `tags`, and `tag` are gateway-only and are stripped before any upstream call.
- Model access is enforced with `allowModel` on every verb, including batches, and `modelChain` on every alias in caller `fallbacks`/`fallback` (403 `model_access_denied`). Permitted aliases include model-template matches. `/v1/models` and `/v1/models/{id}` expose only permitted aliases and also accept `x-api-key`.
- JSON bodies are capped at 32 MB and uploads at 100 MB (`src/lib/http/api.ts`), answered with 413.
- `/api` is the management API for console resources (keys, model aliases, providers, organizations, teams, projects, budgets, usage, logs). It authenticates only management keys (`sk-mgmt-`, `ManagementKey`); `/v1` rejects them before any lookup. A key's permissions are its granted scope ∩ `MANAGEMENT_PERMISSIONS` ∩ the owner's current role (`src/lib/management/scope.ts`); the owner flag is never honored.
- Every `/api` handler is `export const METHOD = managementRoute(permission, handler)` (`src/lib/management/http.ts`). Handlers validate with `src/schemas/management.ts` (strict, snake_case), call the console server actions under `runAsPrincipal`, and return `src/lib/management/serialize.ts` shapes (`object`, snake_case, `null` for unset references, lists as `{ object: "list", data }`). Must not duplicate action business logic in routes.
- Tenancy and budget routes call the Structure actions through `src/lib/management/structure.ts` (`loadStructure`, `budgetHolders`). Creating a team requires `org_id` and a project requires `team_id`. Budgets are addressed as `/api/budgets/{entity_type}/{entity_id}` with `key`, `user`, `project`, `team`, or `org` (`UNKNOWN_ENTITY_TYPE` otherwise), plus `/temporary` for boosts; `GET /api/budgets` needs `tenancy:read`, writes need `budgets:manage`, and a cap above a parent answers `BUDGET_EXCEEDS_PARENT`.
- `/v1` errors use the OpenAI shape `{ error: { message, type, param, code } }` with codes from `GATEWAY_ERRORS` and types derived from status (`src/lib/gateway/errors.ts`); throw `GateError(status, code, message, { param })` and answer with `gateResponse(err, req)` (`src/lib/gateway/gate.ts`). `/v1/messages*` and any `/v1` request with `anthropic-version` get the Anthropic shape `{ type: "error", error: { type, message }, request_id }`. Upstream errors keep the provider `code`/`param` except on 401/403. Unknown failures answer `internal_error` without the original message.
- `/api` and `/internal-api` errors are RFC 9457 `application/problem+json` (`type`, `title`, `status`, `detail`, `instance`, `code`, `request_id`, optional `errors` with JSON pointers) via `problemResponse` / `problemFromError` (`src/lib/http/problem.ts`). Codes are UPPER_SNAKE from `PROBLEMS` (`src/lib/http/problems.ts`); add new codes there. `type` links to `/api-ref#error-CODE`. Every error carries `x-request-id`.
- Internal JSON uses `NextResponse.json`. Must not export `writeJSON`.
- `/internal-api/setup` is the only first-operator create path. Register, SSO, and SCIM return `SETUP_REQUIRED` when `User` count is 0.
- SCIM is `/scim/v2/Users` with the SCIM bearer token and `application/scim+json`. The token is created, replaced, or revoked in Admin settings (`settings:manage`, every permission because SCIM can assign `admin`, plus step-up), shown once, and stored as a hash in `Setting` `scim_token_hash`.
- OIDC is `/sso/login` and `/sso/callback`.
- Session-gated console endpoints are not public contracts: log export `GET /internal-api/logs/export?kind=requests|spend|audit&format=csv|jsonl`, chargeback CSV `GET /internal-api/usage/chargeback`, usage PDF `GET /internal-api/usage/export`, API reference try-out `POST /internal-api/api-ref/try`, assistant `POST /internal-api/assistant/chat` (SSE; `write` enables write tools for that request).
- Log export accepts the console filters `model`, `status`, `endpoint`, `keyId`, `userId`, `pii=1`, `from`, and `to`, parsed by `parseLogFilters` and applied through the same where builders as the Logs page (`src/lib/gateway/request-log-query.ts`). Request content appears only in JSONL, only with `logs:content`, at most 1000 rows, and each such export writes a `log.content_export` audit row.
- Sign-in runs as server actions in `src/app/account/login/_action.ts`. `/internal-api/account` keeps `register` (403 `REGISTRATION_DISABLED` unless Admin settings enable it), `forgot-password` (404 `RESET_DISABLED` without `SMTP_URL`, 429 `RATE_LIMITED`), `reset-password`, `logout` (POST, 303), and `expired` (clears a stale session cookie).
- Health is liveness (`/internal-api/health`). Ready probes Postgres with a Prisma read (`/internal-api/ready`). Version (`/internal-api/version`) returns `BUILD_ID` (`development` when unset) and the process start time, uncached. Do not add top-level health, version, or metrics routes.

## Prohibited patterns

- Do not put gateway handlers or session-cookie routes under `src/app/api/`.
- Do not hand-build error JSON; use `gateResponse` or `problemResponse`.
- Do not skip `gateRequest` / PII / budget on new `/v1` verbs that consume models, and do not record usage without the traced principal.

## Validation

`test/openai-routes.test.ts`, `test/health-routes.test.ts`, `test/v1-auth.test.ts`, `test/api-errors.test.ts`, `test/management-api.test.ts`, `test/openapi-paths.test.ts` (catalog parity for `/v1` and `/api`), and route-specific tests under `test/`.
