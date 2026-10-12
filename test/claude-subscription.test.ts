import assert from "node:assert/strict";
import test from "node:test";
import { CLAUDE_CODE_IDENTITY, withClaudeBetas, withClaudeIdentity } from "@/lib/gateway/upstreams/claude";
import { signInHeaders } from "@/lib/gateway/upstreams/credentials";
import { joinPath, prepareBody, upstreamError, upstreamHeaders, upstreamRetryAt } from "@/lib/gateway/dispatch/upstream";
import { routePool } from "@/lib/gateway/routing/route-pool";
import type { ResolvedDeployment } from "@/types/gateway";

const claudeDep: ResolvedDeployment = {
  id: "c1",
  kind: "claude",
  base_url: "https://evil.example",
  model: "claude-sonnet-4-5",
  weight: 1,
  cost_input_per_1k: 0,
  cost_output_per_1k: 0,
  provider_id: "p1",
};

test("Claude subscription deployments belong to the subscription pool", () => {
  assert.equal(routePool({ kind: "claude" }), "subscription");
  assert.equal(routePool({ kind: "anthropic", provider: { kind: "claude" } }), "subscription");
  assert.equal(routePool({ kind: "anthropic" }), "api");
});

test("Claude deployments use the pinned Messages endpoint", () => {
  assert.equal(joinPath(claudeDep, "/chat/completions"), "https://api.anthropic.com/v1/messages");
  assert.equal(joinPath(claudeDep, "/v1/messages"), "https://api.anthropic.com/v1/messages");
});

test("Claude requests send the OAuth bearer token and merge client betas", () => {
  const headers = upstreamHeaders(
    claudeDep,
    { key: "sk-ant-oat01-a", headers: signInHeaders("claude", { access: "a", refresh: "r", accountId: "", residency: "" }) },
    { "anthropic-beta": "context-1m-2025-08-07, oauth-2025-04-20", "x-api-key": "spoofed" },
  );
  assert.equal(headers.Authorization, "Bearer sk-ant-oat01-a");
  assert.equal(headers["anthropic-version"], "2023-06-01");
  assert.equal(headers["x-app"], "cli");
  assert.match(headers["User-Agent"] ?? "", /^claude-cli\//);
  assert.equal(
    headers["anthropic-beta"],
    "claude-code-20250219,oauth-2025-04-20,context-1m-2025-08-07",
  );
  assert.equal(headers["x-api-key"], "spoofed");
});

test("API key Anthropic deployments keep x-api-key and no OAuth betas", () => {
  const headers = upstreamHeaders({ ...claudeDep, kind: "anthropic" }, { key: "sk-ant-api", headers: {} });
  assert.equal(headers["x-api-key"], "sk-ant-api");
  assert.equal(headers.Authorization, undefined);
  assert.equal(headers["anthropic-beta"], undefined);
});

test("Claude bodies start with the Claude Code identity and keep the caller system prompt", () => {
  const converted = prepareBody(claudeDep, "/chat/completions", {
    model: "alias",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
    ],
    fallbacks: ["other"],
  });
  assert.equal(converted.model, "claude-sonnet-4-5");
  assert.equal("fallbacks" in converted, false);
  const system = converted.system as { type: string; text: string }[];
  assert.equal(system[0]!.text, CLAUDE_CODE_IDENTITY);
  assert.equal(system.at(-1)!.text, "Be brief.");

  const native = prepareBody(claudeDep, "/v1/messages", { model: "alias", max_tokens: 5, system: "Be brief.", messages: [] });
  assert.deepEqual(
    (native.system as { text: string }[]).map((block) => block.text),
    [CLAUDE_CODE_IDENTITY, "Be brief."],
  );
  assert.equal("system" in prepareBody({ ...claudeDep, kind: "anthropic" }, "/v1/messages", { messages: [] }), false);
});

test("the Claude Code identity is not duplicated", () => {
  const once = withClaudeIdentity({ system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, { type: "text", text: "x" }] });
  assert.equal((once.system as unknown[]).length, 2);
  assert.equal((withClaudeIdentity({}).system as unknown[]).length, 1);
});

test("OAuth betas are always present exactly once", () => {
  assert.equal(
    withClaudeBetas({ "Anthropic-Beta": "oauth-2025-04-20,x" })["anthropic-beta"],
    "claude-code-20250219,oauth-2025-04-20,x",
  );
  assert.equal(withClaudeBetas({ "Content-Type": "application/json" })["Content-Type"], "application/json");
});

test("Anthropic rate limit headers park the route until the unified reset", () => {
  const headers = new Headers({ "anthropic-ratelimit-unified-reset": "1900000000" });
  assert.equal(upstreamRetryAt(429, { type: "error" }, 0, headers), 1_900_000_000_000);
  assert.equal(upstreamRetryAt(500, {}, 0, headers), null);
  assert.equal(upstreamError(429, { error: { message: "limit" } }, headers).retryAt, 1_900_000_000_000);
  assert.equal(upstreamError(429, { error: { message: "limit" } }).retryAt, null);
});
