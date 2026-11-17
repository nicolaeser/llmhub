import assert from "node:assert/strict";
import test from "node:test";
import { anthropicCatalogAlias, anthropicPublicIds } from "@/lib/gateway/catalog/anthropic-native";
import { namedBody, namedModel } from "@/lib/gateway/catalog/model-names";

const HAIKU = "claude-haiku-4-5";
const HAIKU_DATED = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const SONNET_55 = "claude-sonnet-5-5";

test("dated, qualified, and bracketed Anthropic ids resolve to the one catalog model", () => {
  const aliases = new Set([HAIKU, SONNET_55, "claude-opus-4-20250514"]);
  for (const id of [
    HAIKU_DATED,
    "claude-haiku-4-5@20251001",
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    "anthropic.claude-haiku-4-5",
    "publishers/anthropic/models/claude-haiku-4-5",
    `${HAIKU}[1m]`,
    `${HAIKU_DATED}[1m]`,
    "Claude-Haiku-4.5",
  ]) {
    assert.equal(anthropicCatalogAlias(id, aliases), HAIKU, id);
  }
  assert.equal(anthropicCatalogAlias("claude-opus-4-0", aliases), "claude-opus-4-20250514");
  assert.equal(anthropicCatalogAlias("claude-opus-4", aliases), "claude-opus-4-20250514");
  assert.equal(anthropicCatalogAlias(HAIKU, aliases), undefined);
  assert.equal(anthropicCatalogAlias(SONNET_55, aliases), undefined);
});

test("a dated catalog id accepts the undated id, and the reverse stays one model", () => {
  assert.equal(anthropicCatalogAlias(HAIKU, new Set([HAIKU_DATED])), HAIKU_DATED);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, new Set([HAIKU_DATED])), undefined);
  const both = new Set([HAIKU, HAIKU_DATED]);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, both), undefined);
  assert.equal(anthropicCatalogAlias(HAIKU, both), undefined);
  assert.equal(anthropicCatalogAlias("us.anthropic.claude-haiku-4-5-20251001-v1:0", both), HAIKU);
});

test("a different Claude release is not an alias", () => {
  const aliases = new Set([SONNET_55, "claude-haiku-5-5", "claude-opus-5-5"]);
  assert.equal(anthropicCatalogAlias(SONNET, aliases), undefined);
  assert.equal(anthropicCatalogAlias("claude-sonnet-5[1m]", aliases), undefined);
  assert.equal(anthropicCatalogAlias("claude-not-a-model", aliases), undefined);
  assert.equal(anthropicCatalogAlias("gpt-5", aliases), undefined);
  assert.equal(namedModel(SONNET, new Map(), aliases), SONNET);
  assert.equal(namedModel("api/claude-haiku-4-5-20251001", new Map(), new Set([HAIKU])), `api/${HAIKU}`);
  assert.deepEqual(namedBody({ model: HAIKU_DATED, fallbacks: [HAIKU_DATED], messages: [] }, new Map(), new Set([HAIKU])), {
    model: HAIKU,
    fallbacks: [HAIKU],
    messages: [],
  });
});

test("an operator name wins over the native id, and a real alias is not rewritten by the map", () => {
  const aliases = new Set([HAIKU, "gpt-test"]);
  const names = new Map([[HAIKU_DATED, "gpt-test"]]);
  assert.equal(namedModel(HAIKU_DATED, names, aliases), "gpt-test");
});

test("gateway discovery ids are the spellings Claude Code calls, and only when they are not already models", () => {
  assert.deepEqual(anthropicPublicIds(HAIKU, new Set([HAIKU])), [HAIKU_DATED]);
  assert.deepEqual(anthropicPublicIds(HAIKU_DATED, new Set([HAIKU_DATED])), [HAIKU]);
  assert.deepEqual(anthropicPublicIds(SONNET_55, new Set([SONNET_55])), []);
  assert.deepEqual(anthropicPublicIds(SONNET, new Set([SONNET])), []);
  assert.deepEqual(anthropicPublicIds("claude-opus-4-0", new Set(["claude-opus-4-0"])), [
    "claude-opus-4-20250514",
    "claude-opus-4",
  ]);
  assert.deepEqual(anthropicPublicIds(HAIKU, new Set([HAIKU, HAIKU_DATED])), []);
});
