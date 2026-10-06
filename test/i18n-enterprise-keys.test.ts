import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const LOCALES = ["en", "de"] as const;

const KEYS = [
  "Roles.templateName",
  "Logging.spendRetention",
  "Logging.webhookSecret",
  "Usage.chargeback",
  "Usage.metrics.rate429",
  "Usage.metrics.p95",
  "Usage.group.org",
  "Usage.group.project",
  "Budgets.saveBudget",
  "Logs.columns.org",
  "Logs.columns.cost",
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function lookup(messages: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cursor, segment) => {
    if (!isPlainObject(cursor)) return undefined;
    return cursor[segment];
  }, messages);
}

async function loadNamespace(locale: string, ns: string) {
  const file = path.join(root, "lang", locale, `${ns}.json`);
  assert.ok(existsSync(file), `missing ${locale}/${ns}.json`);
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

for (const locale of LOCALES) {
  test(`${locale} has enterprise i18n keys`, async () => {
    const namespaces = new Map<string, unknown>();
    for (const key of KEYS) {
      const ns = key.slice(0, key.indexOf("."));
      if (!namespaces.has(ns)) {
        namespaces.set(ns, await loadNamespace(locale, ns));
      }
      const rest = key.slice(ns.length + 1);
      const value = lookup(namespaces.get(ns), rest);
      assert.equal(typeof value, "string", `${locale} missing ${key}`);
      assert.ok(
        (value as string).trim().length > 0,
        `${locale} empty ${key}`,
      );
    }
  });
}
