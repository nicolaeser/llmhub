import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTranslator } from "next-intl";
import {
  ADD_PROVIDER_FILTERS,
  filterOf,
  kindSearchText,
  optionById,
  poolTab,
  providerOptions,
  sectionsFor,
  type KindText,
} from "@/app/(app)/providers/_components/provider-options";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";

const root = fileURLToPath(new URL("../..", import.meta.url));

function searchTextIn(locale: "en" | "de") {
  const messages = JSON.parse(readFileSync(path.join(root, `lang/${locale}/Providers.json`), "utf8"));
  const t = createTranslator({ locale, messages: { Providers: messages }, namespace: "Providers" });
  return (kind: string) => kindSearchText(kind, (key: KindText, value: string) => t(key, { kind: value }));
}

function matches(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

const kindOptions = () => [...providerOptions("api"), ...providerOptions("subscription")];

test("every catalog kind appears exactly once in the picker", () => {
  const ids = kindOptions().map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), PROVIDER_CATALOG.map((spec) => spec.kind).sort());
  for (const option of kindOptions()) {
    assert.ok(option.section !== "import" && option.spec.kind === option.id);
  }
});

test("sign-in kinds appear only in the subscription section", () => {
  for (const option of providerOptions("api")) {
    assert.equal(option.section, "api");
    assert.equal(isSignInKind(option.id), false, option.id);
  }
  for (const option of providerOptions("subscription")) {
    assert.equal(option.section, "subscription");
    assert.equal(isSignInKind(option.id), true, option.id);
  }
});

test("the import section offers auth files, CLIProxyAPI, and an add-account link", () => {
  assert.deepEqual(
    providerOptions("import").map((option) => (option.section === "import" ? option.option : option.id)),
    ["files", "server", "link"],
  );
  const ids = [...kindOptions(), ...providerOptions("import")].map((option) => option.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("filters choose the sections and kinds map to their pool", () => {
  assert.deepEqual(sectionsFor("all"), ["api", "subscription", "import"]);
  for (const filter of ADD_PROVIDER_FILTERS.filter((item) => item !== "all")) {
    assert.deepEqual(sectionsFor(filter), [filter]);
  }
  assert.equal(filterOf("claude"), "subscription");
  assert.equal(filterOf("vertex"), "api");
  assert.equal(poolTab("kimi_ai"), "subscriptions");
  assert.equal(poolTab("moonshot_cn"), "api");
  assert.equal(optionById("import:server")?.section, "import");
  assert.equal(optionById("codex")?.section, "subscription");
  assert.equal(optionById("nope"), null);
  assert.equal(optionById(null), null);
});

test("search text carries the region words of the Kimi and Moonshot kinds", () => {
  for (const locale of ["en", "de"] as const) {
    const text = searchTextIn(locale);
    assert.ok(matches(text("moonshot_cn"), "china") && matches(text("moonshot_cn"), "moonshot.cn"), locale);
    assert.ok(matches(text("moonshot"), "global") && matches(text("moonshot"), "moonshot.ai"), locale);
    assert.ok(matches(text("kimi"), "china") && matches(text("kimi"), "kimi.com"), locale);
    assert.ok(matches(text("kimi_ai"), "global") && matches(text("kimi_ai"), "kimi.ai"), locale);
    const hits = (query: string) =>
      kindOptions()
        .filter((option) => matches(text(option.id), query))
        .map((option) => option.id)
        .sort();
    assert.deepEqual(hits("kimi"), ["kimi", "kimi_ai", "moonshot", "moonshot_cn"], locale);
    assert.deepEqual(hits("china"), ["kimi", "moonshot_cn"], locale);
    assert.ok(hits("moonshot").includes("moonshot_cn"), locale);
    assert.ok(hits("vertex").includes("vertex"), locale);
  }
});
