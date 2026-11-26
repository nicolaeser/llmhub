# Session affinity

Load when changing deployment selection in `acquireGroup`, deployment or account pins, the conversation fingerprint, or when debugging prefix-cache misses on self-hosted replicas.

## Why it exists

Self-hosted inference servers (vLLM, SGLang, llama.cpp, TGI) keep a prefix/KV cache per replica. Coding agents resend the whole, only-growing conversation every step (20k–200k tokens), so a step that lands on another replica re-prefills everything and slows every other request on that replica. With long conversations the re-prefill dominates time to first token, so staying on the replica turns a long wait into a short one. A load balancer in front of the replicas cannot help, because all traffic comes from the hub without cookies. The gateway is the only place that can tell conversations apart.

## Decisions

- Opt-in per model group: `ModelGroup.sessionAffinity` (console switch in the model group dialog, `session_affinity` on `/api/mgmt/models` and `/api/mgmt/models/{alias}`, preserved by `catalogOwnedGroups` like `mergeSystemMessages`). Default off; without it routing is unchanged.
- The group's strategy still makes the first placement of a conversation. Affinity only remembers it.
- A pin names a deployment id, never a provider, because replicas usually share one model and differ only by base URL.
- The fingerprint covers the system prompt and the first user message, not the system prompt alone; otherwise every user of the same client would land on one replica.

## Key derivation

`affinitySessionSource` in `src/lib/gateway/routing/session-fingerprint.ts` takes the first of:

1. `client`: `clientSessionKey` from `account-affinity.ts` (`prompt_cache_key`, Claude Code's metadata cache key, `x-claude-code-session-id`).
2. `header`: `x-session-affinity` (`SESSION_AFFINITY_HEADER`), at most `MAX_SESSION_LENGTH` (512) characters. `gateModelRequest` (`src/lib/gateway/endpoints/pipeline.ts`) copies it and `x-claude-code-session-id` into `trace.sessionHeaders`; `UNFORWARDED_CLIENT_HEADERS` (`src/lib/gateway/dispatch/upstream.ts`) keeps it from every upstream.
3. `fingerprint`: `conversationFingerprint(body)`. A Responses `conversation` id is used as is; a request with only `previous_response_id` has no fingerprint. Otherwise it hashes the opening: leading `system` (Messages, without the Claude Code billing block), `system` and `developer` messages, or Responses `instructions`, plus the first user message or input item. Only text counts; media parts contribute their type and a length plus hash of their reference. Line endings and trailing spaces are normalized, and system and user text are each capped at `FINGERPRINT_LIMIT_BYTES` (64 KB).

The session is the first 32 hex characters of a SHA-256 over a version tag, the caller scope (`affinityScope`: project id, else member id, else key id), the group alias, the source, and the key. Appended assistant, tool, or user turns keep the key; client-side compaction yields a new one, which is correct because the replica has no cache for the new opening.

## Pins and selection

- Pins live in `src/lib/gateway/routing/deployment-affinity.ts` on `PinStore` (`src/lib/gateway/routing/pin-store.ts`), the store extracted from and still used by subscription account pins (`account-affinity.ts`): Redis key `llmhub:deployment-pin:v1:<group>:<session>`, in-process fallback when Redis is absent or failing, sliding TTL of 30 minutes from last use, at most `MAX_PINS` (20,000) local entries per store.
- `withDeployment` (chat completions, Responses, Messages) and `forwardToModel` (the other model endpoints, so a flagged embeddings group pins by its `input` too) build `RunRouting.affinity` with `runAffinity`; `groupSession` derives the session once per group and run.
- `acquireGroup` (`src/lib/gateway/routing/runtime.ts`) reads the pin and asks the pure `affinityPlan` after health, cooldown, concurrency, and account-pin filtering: `hit` when the pinned deployment is still a candidate, not in `RunAffinity.failed`, and `inflight(pinned) <= min(inflight of candidates) + SESSION_AFFINITY_SPILL_MARGIN` (env, integer ≥ 0, default 4; TTL extended with `touchDeploymentPin`); `spill` when it is over that margin (the pool drops it) or merely has no free permit; `failover` when it is unhealthy, cooling down, filtered out, or already failed in this run; `new` without a pin; `off` when the flag is on but no key is derivable. `spill`, `failover`, and `new` let the strategy pick and overwrite the pin (`settleDeploymentPin`, not awaited).
- Retries, fallback groups, overflow, and the API spill keep their semantics. A deployment already tried in a run is never pulled back by a pin.
- Subscription account pinning (provider-id pins of sign-in kinds, `PIN_HOLD_MS`, handoffs) is unchanged and independent of this flag.

## Visibility and privacy

- `noteAffinity` remembers the outcome per acquired deployment (`servedAffinity`, read by `writeRequestLog`), and `noteServed` sets `trace.affinityDeployment`, which `gatewayRoute` turns into `x-llmhub-deployment: <deployment id>` (`withDeploymentHeader`). Internal-pool forwards record neither.
- `RequestLog.affinity` (`hit`, `new`, `spill`, `failover`, `off`, empty when the flag is off) and `RequestLog.affinityKey` (the hashed session) are shown in the console request log detail and written to the log archive as `affinity` and `affinity_key`.
- Every key is stored hashed. No prompt text reaches logs, Redis, or the database through affinity.

## Limits

- Compaction creates a new assignment.
- Load is distributed per conversation, not per request; a few very large conversations can skew replicas until spill moves them.
- In-process pins are per instance. Multi-instance deployments need Redis to share pins.

## Validation

`src/tests/session-fingerprint.test.ts` (key order and fingerprint stability), `src/tests/deployment-affinity.test.ts` (plan outcomes and pins), and `src/tests/openapi-paths.test.ts` (documented headers).
