import fs from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import { routing } from "./routing";
import type { Messages } from "@/types/i18n";

const langRoot = path.join(process.cwd(), "lang");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base: Messages, override: Messages): Messages {
  const merged: Messages = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = merged[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      merged[key] = deepMerge(current, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function assignDottedNamespace(
  target: Messages,
  dottedPath: string,
  payload: Messages,
) {
  const segments = dottedPath.split(".");
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const existing = cursor[segment];
    if (!isPlainObject(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Messages;
  }
  const leaf = segments[segments.length - 1];
  const existingLeaf = cursor[leaf];
  cursor[leaf] = isPlainObject(existingLeaf)
    ? deepMerge(existingLeaf, payload)
    : payload;
}

async function collectJsonFiles(
  baseDir: string,
  relative = "",
): Promise<string[]> {
  const entries = await fs.readdir(path.join(baseDir, relative), {
    withFileTypes: true,
  });
  const collected: string[] = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      collected.push(...(await collectJsonFiles(baseDir, next)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      collected.push(next);
    }
  }
  return collected.sort((a, b) => a.localeCompare(b));
}

function relativePathToDottedNamespace(relativePath: string): string {
  const segments = relativePath.slice(0, -".json".length).split("/");
  if (segments.length > 1 && segments[segments.length - 1] === "page") {
    segments.pop();
  }
  return segments.join(".");
}

async function readLocaleNamespaces(locale: string): Promise<Messages> {
  const localeDir = path.join(langRoot, locale);
  const files = await collectJsonFiles(localeDir);
  const messages: Messages = {};
  for (const file of files) {
    const dottedPath = relativePathToDottedNamespace(file);
    const raw = await fs.readFile(path.join(localeDir, file), "utf8");
    assignDottedNamespace(messages, dottedPath, JSON.parse(raw) as Messages);
  }
  return messages;
}

export const loadLocaleMessages = cache(
  async (requestedLocale: string): Promise<Messages> => {
    const locale = routing.locales.includes(
      requestedLocale as (typeof routing.locales)[number],
    )
      ? requestedLocale
      : routing.defaultLocale;
    const enMessages = await readLocaleNamespaces(routing.defaultLocale);
    if (locale === routing.defaultLocale) return enMessages;
    try {
      return deepMerge(enMessages, await readLocaleNamespaces(locale));
    } catch {
      return enMessages;
    }
  },
);
