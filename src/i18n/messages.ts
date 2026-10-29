import fs from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import { routing } from "./routing";
import type { Messages } from "@/types/i18n";
import { assignMessagePath, mergeMessages } from "./message-tree";

const langRoot = path.join(process.cwd(), "lang");

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
    assignMessagePath(messages, dottedPath, JSON.parse(raw) as Messages);
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
      return mergeMessages(enMessages, await readLocaleNamespaces(locale));
    } catch {
      return enMessages;
    }
  },
);
