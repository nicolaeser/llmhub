import assert from "node:assert/strict";
import test from "node:test";
import {
  draftBody,
  draftFor,
  draftReady,
  retentionValid,
  vertexDraftReady,
} from "@/app/(app)/providers/_components/provider-draft";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { VERTEX_DEFAULT_LOCATION } from "@/lib/gateway/upstreams/vertex-target";
import type { ProviderKindSpec, ProviderView } from "@/types/providers";

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: "hub-test-project",
  private_key_id: "key-1",
  private_key: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
  client_email: "hub@hub-test-project.iam.gserviceaccount.com",
  client_id: "1234567890",
});

function spec(kind: string): ProviderKindSpec {
  const found = PROVIDER_CATALOG.find((item) => item.kind === kind);
  assert.ok(found, kind);
  return found;
}

function row(overrides: Partial<ProviderView>): ProviderView {
  return {
    id: "p1",
    name: "Stored",
    kind: "openai",
    baseUrl: "https://stored.example/v1",
    hasApiKey: true,
    enabled: true,
    restricted: false,
    internal: false,
    assignments: [],
    signIn: null,
    sharedVia: null,
    manageActive: false,
    discovered: [],
    policy: { zdr: false, retentionDays: 30, region: "us", noTraining: true },
    vertex: null,
    ...overrides,
  };
}

test("a new draft starts from the catalog defaults", () => {
  const draft = draftFor(spec("openrouter_eu"), null, "OpenRouter EU");
  assert.equal(draft.name, "OpenRouter EU");
  assert.equal(draft.baseUrl, "https://eu.openrouter.ai/api/v1");
  assert.equal(draft.region, "eu");
  assert.equal(draft.retention, "");
  assert.equal(draft.zdr, false);
  assert.deepEqual(draft.vertex, {
    credential: "service_account",
    serviceAccount: "",
    project: "",
    location: VERTEX_DEFAULT_LOCATION,
  });
  assert.equal(draftFor(spec("openai_compat"), null, "").baseUrl, "");
});

test("an edit draft keeps the stored values but never the stored secret", () => {
  const draft = draftFor(spec("openai"), row({}), "OpenAI");
  assert.equal(draft.name, "Stored");
  assert.equal(draft.baseUrl, "https://stored.example/v1");
  assert.equal(draft.apiKey, "");
  assert.equal(draft.retention, "30");
  assert.equal(draft.region, "us");
  assert.equal(draft.noTraining, true);
  const zdr = draftFor(spec("openai"), row({ policy: { zdr: true, retentionDays: 0, region: "", noTraining: true } }), "");
  assert.equal(zdr.zdr, true);
  assert.equal(zdr.retention, "");
  const vertex = draftFor(
    spec("vertex"),
    row({ kind: "vertex", vertex: { credential: "api_key", account: "", project: "p-123456", location: "" } }),
    "",
  );
  assert.deepEqual(vertex.vertex, {
    credential: "api_key",
    serviceAccount: "",
    project: "p-123456",
    location: VERTEX_DEFAULT_LOCATION,
  });
});

test("zero data retention forces retention 0 and no training", () => {
  const base = draftFor(spec("openai"), null, "OpenAI");
  const zdr = draftBody(spec("openai"), { ...base, zdr: true, retention: "90", noTraining: false });
  assert.deepEqual(zdr.policy, { zdr: true, retentionDays: 0, region: "", noTraining: true });
  const days = draftBody(spec("openai"), { ...base, retention: " 30 ", noTraining: true, region: "eu" });
  assert.deepEqual(days.policy, { zdr: false, retentionDays: 30, region: "eu", noTraining: true });
  const unknown = draftBody(spec("openai"), { ...base, retention: "  " });
  assert.equal(unknown.policy.retentionDays, null);
  assert.equal(unknown.policy.noTraining, false);
});

test("retention must be up to four digits unless ZDR is on", () => {
  const base = draftFor(spec("openai"), null, "OpenAI");
  assert.equal(retentionValid({ ...base, retention: "" }), true);
  assert.equal(retentionValid({ ...base, retention: "3650" }), true);
  assert.equal(retentionValid({ ...base, retention: "12345" }), false);
  assert.equal(retentionValid({ ...base, retention: "abc" }), false);
  assert.equal(retentionValid({ ...base, retention: "abc", zdr: true }), true);
  assert.equal(draftReady(spec("openai"), null, { ...base, retention: "-1" }), false);
});

test("only API key kinds carry the internal flag", () => {
  const fresh = draftFor(spec("openai"), null, "OpenAI");
  assert.equal(fresh.internal, false);
  assert.equal(draftBody(spec("openai"), fresh).internal, false);
  const stored = draftFor(spec("openai"), row({ internal: true }), "OpenAI");
  assert.equal(stored.internal, true);
  assert.equal(draftBody(spec("openai"), stored).internal, true);
  assert.equal(draftBody(spec("vertex"), { ...draftFor(spec("vertex"), null, "Vertex"), internal: true }).internal, true);
  assert.equal(draftBody(spec("codex"), { ...draftFor(spec("codex"), null, "ChatGPT"), internal: true }).internal, undefined);
});

test("base URLs are sent only for API key kinds", () => {
  const custom = draftBody(spec("openai_compat"), {
    ...draftFor(spec("openai_compat"), null, "Local"),
    baseUrl: "  http://127.0.0.1:8000/v1 ",
    apiKey: "sk-test",
  });
  assert.equal(custom.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(custom.apiKey, "sk-test");
  assert.equal(custom.signIn, undefined);
  assert.equal(custom.vertex, undefined);
  const signIn = draftBody(spec("codex"), { ...draftFor(spec("codex"), null, "ChatGPT"), signIn: "sealed" });
  assert.equal(signIn.baseUrl, "");
  assert.equal(signIn.signIn, "sealed");
  assert.equal(draftBody(spec("vertex"), draftFor(spec("vertex"), null, "Vertex")).baseUrl, "");
});

test("a Vertex service account sends the key file and its target", () => {
  const draft = {
    ...draftFor(spec("vertex"), null, "Vertex"),
    apiKey: "ignored",
    vertex: { credential: "service_account" as const, serviceAccount: SERVICE_ACCOUNT, project: "hub-test-project", location: "europe-west4" },
  };
  assert.equal(draftReady(spec("vertex"), null, draft), true);
  const body = draftBody(spec("vertex"), draft);
  assert.equal(body.apiKey, SERVICE_ACCOUNT);
  assert.deepEqual(body.vertex, { project: "hub-test-project", location: "europe-west4" });
  const express = draftBody(spec("vertex"), { ...draft, apiKey: "AIza-test", vertex: { ...draft.vertex, credential: "api_key" } });
  assert.equal(express.apiKey, "AIza-test");
  assert.equal(express.vertex, undefined);
});

test("Vertex readiness needs a valid key file or a kept credential", () => {
  const empty = { credential: "service_account" as const, serviceAccount: "", project: "p-123456", location: "global" };
  assert.equal(vertexDraftReady(empty, "", null), false);
  assert.equal(vertexDraftReady({ ...empty, serviceAccount: "{}" }, "", null), false);
  assert.equal(vertexDraftReady({ ...empty, serviceAccount: SERVICE_ACCOUNT, project: "" }, "", null), false);
  assert.equal(vertexDraftReady({ ...empty, serviceAccount: SERVICE_ACCOUNT }, "", null), true);
  const stored = { credential: "service_account" as const, account: "hub@x", project: "p-123456", location: "global" };
  assert.equal(vertexDraftReady(empty, "", stored), true);
  assert.equal(vertexDraftReady({ ...empty, credential: "api_key" }, "", stored), false);
  assert.equal(vertexDraftReady({ ...empty, credential: "api_key" }, "AIza", stored), true);
});

test("sign-in kinds need a fresh sign-in to connect but not to edit", () => {
  const draft = draftFor(spec("claude"), null, "Claude");
  assert.equal(draftReady(spec("claude"), null, draft), false);
  assert.equal(draftReady(spec("claude"), null, { ...draft, signIn: "sealed" }), true);
  assert.equal(draftReady(spec("claude"), row({ kind: "claude" }), draft), true);
  assert.equal(draftReady(null, null, draft), false);
});
