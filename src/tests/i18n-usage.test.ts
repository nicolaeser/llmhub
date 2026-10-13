import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

const PAGES: { slug: string; english: string[] }[] = [
  { slug: "companies", english: ["Companies"] },
  { slug: "users", english: ["Internal users", "Internal Users"] },
  { slug: "providers", english: ["Providers"] },
  { slug: "models", english: ["Models + Endpoints"] },
  { slug: "usage", english: ["Usage"] },
  { slug: "guardrails", english: ["Guardrails"] },
  { slug: "developer", english: ["Developer", "API reference", "API Reference"] },
  { slug: "settings", english: ["Settings"] },
];

function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

for (const { slug, english } of PAGES) {
  const file = path.join(root, "src/app/(app)", slug, "page.tsx");
  test(
    `${slug} imports useTranslations and has no hardcoded English h1`,
    { skip: !existsSync(file) },
    async () => {
      const source = await readFile(file, "utf8");
      assert.match(source, /useTranslations/);
      assert.match(source, /from ["']next-intl["']/);
      for (const title of english) {
        assert.doesNotMatch(
          source,
          new RegExp(`>\\s*${escapeRe(title)}\\s*</h1>`),
        );
      }
    },
  );
}
