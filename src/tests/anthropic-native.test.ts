import assert from "node:assert/strict";
import test from "node:test";
import { anthropicAliasIndex, anthropicCatalogAlias, anthropicPublicIds } from "@/lib/gateway/catalog/anthropic-native";
import { namedBody, namedModel } from "@/lib/gateway/catalog/model-names";

const HAIKU = "claude-haiku-4-5";
const HAIKU_DATED = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-5";
const SONNET_55 = "claude-sonnet-5-5";

const catalog = (enabled: string[], disabled: string[] = []) =>
  anthropicAliasIndex([
    ...enabled.map((alias) => ({ alias, enabled: true })),
    ...disabled.map((alias) => ({ alias, enabled: false })),
  ]);

test("dated, qualified, and bracketed Anthropic ids resolve to the one catalog model", () => {
  const aliases = catalog([HAIKU, SONNET_55, "claude-opus-4-20250514"]);
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
  assert.equal(anthropicCatalogAlias(HAIKU, catalog([HAIKU_DATED])), HAIKU_DATED);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, catalog([HAIKU_DATED])), undefined);
  const both = catalog([HAIKU, HAIKU_DATED]);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, both), undefined);
  assert.equal(anthropicCatalogAlias(HAIKU, both), undefined);
  assert.equal(anthropicCatalogAlias("us.anthropic.claude-haiku-4-5-20251001-v1:0", both), HAIKU);
});

test("a different Claude release is not an alias", () => {
  const aliases = catalog([SONNET_55, "claude-haiku-5-5", "claude-opus-5-5"]);
  assert.equal(anthropicCatalogAlias(SONNET, aliases), undefined);
  assert.equal(anthropicCatalogAlias("claude-sonnet-5[1m]", aliases), undefined);
  assert.equal(anthropicCatalogAlias("claude-not-a-model", aliases), undefined);
  assert.equal(anthropicCatalogAlias("gpt-5", aliases), undefined);
  assert.equal(namedModel(SONNET, new Map(), aliases), SONNET);
  assert.equal(namedModel("api/claude-haiku-4-5-20251001", new Map(), catalog([HAIKU])), `api/${HAIKU}`);
  assert.deepEqual(namedBody({ model: HAIKU_DATED, fallbacks: [HAIKU_DATED], messages: [] }, new Map(), catalog([HAIKU])), {
    model: HAIKU,
    fallbacks: [HAIKU],
    messages: [],
  });
});

test("an operator name wins over the native id, and a real alias is not rewritten by the map", () => {
  const aliases = catalog([HAIKU, "gpt-test"]);
  const names = new Map([[HAIKU_DATED, "gpt-test"]]);
  assert.equal(namedModel(HAIKU_DATED, names, aliases), "gpt-test");
});

test("discovery candidates are the spellings Claude Code calls", () => {
  assert.deepEqual(anthropicPublicIds(HAIKU), [HAIKU_DATED]);
  assert.deepEqual(anthropicPublicIds(HAIKU_DATED), [HAIKU]);
  assert.deepEqual(anthropicPublicIds(SONNET_55), []);
  assert.deepEqual(anthropicPublicIds("claude-opus-4-0"), ["claude-opus-4-20250514", "claude-opus-4"]);
  assert.deepEqual(anthropicPublicIds("gpt-5"), []);
});

test("a dated id only matches its own snapshot", () => {
  const sonnet35 = catalog(["claude-3-5-sonnet-20241022"]);
  assert.equal(anthropicCatalogAlias("claude-3-5-sonnet-20240620", sonnet35), undefined);
  assert.equal(anthropicCatalogAlias("claude-3-5-sonnet", sonnet35), "claude-3-5-sonnet-20241022");
  assert.equal(anthropicCatalogAlias("claude-haiku-4-5-20250101", catalog([HAIKU])), undefined);
  assert.equal(anthropicCatalogAlias("claude-3-5-sonnet-20240620", catalog(["claude-3-5-sonnet"])), undefined);
});

test("a disabled or ambiguous release never falls through to another model", () => {
  const disabledExact = catalog(["vertex-claude-opus-4-5"], ["claude-opus-4-5"]);
  assert.equal(anthropicCatalogAlias("claude-opus-4-5", disabledExact), undefined);
  assert.equal(anthropicCatalogAlias("claude-opus-4-5-20251101", disabledExact), undefined);
  const disabledTwin = catalog(["bedrock-claude-haiku-4-5"], ["vertex-claude-haiku-4-5"]);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, disabledTwin), undefined);
  assert.equal(anthropicCatalogAlias(HAIKU, catalog(["bedrock-claude-haiku-4-5", "vertex-claude-haiku-4-5"])), undefined);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, catalog(["bedrock-claude-haiku-4-5"])), "bedrock-claude-haiku-4-5");
  assert.equal(anthropicCatalogAlias(`${HAIKU}[1m]`, catalog([], [HAIKU])), undefined);
  assert.equal(anthropicCatalogAlias(HAIKU_DATED, catalog([HAIKU, "vertex-claude-haiku-4-5"])), HAIKU);
});
