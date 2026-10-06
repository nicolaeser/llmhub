#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { createTranslator } from "next-intl";

const ROOT = path.join(process.cwd(), "lang");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function collectJsonFiles(dir, relative = "") {
  let entries;
  try {
    entries = await fs.readdir(path.join(dir, relative), { withFileTypes: true });
  } catch {
    console.error(`missing locale dir: ${dir}`);
    process.exit(1);
  }
  const files = [];
  for (const entry of entries) {
    const next = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await collectJsonFiles(dir, next)));
    else if (entry.isFile() && entry.name.endsWith(".json")) files.push(next);
  }
  return files;
}

function flatten(value, prefix, out) {
  if (!isPlainObject(value)) {
    if (prefix) out.add(prefix);
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    flatten(nested, prefix ? `${prefix}.${key}` : key, out);
  }
}

async function load(locale) {
  const dir = path.join(ROOT, locale);
  const files = await collectJsonFiles(dir);
  const keys = new Set();
  const messages = {};
  for (const file of files) {
    const json = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    const segments = file.replace(/\.json$/, "").split("/");
    let node = messages;
    for (const segment of segments.slice(0, -1)) node = node[segment] ??= {};
    node[segments.at(-1)] = json;
    flatten(json, segments.join("."), keys);
  }
  return { keys, messages };
}

function invalidMessages(locale, { keys, messages }) {
  const invalid = [];
  let current = "";
  const t = createTranslator({
    locale,
    messages,
    onError: (error) => {
      if (error.code === "INVALID_MESSAGE") invalid.push(`${locale} invalid ICU ${current}`);
    },
  });
  for (const key of keys) {
    current = key;
    t(key, {});
  }
  return invalid;
}

const en = await load("en");
const de = await load("de");
const problems = [];
for (const key of en.keys) if (!de.keys.has(key)) problems.push(`de missing ${key}`);
for (const key of de.keys) if (!en.keys.has(key)) problems.push(`en missing ${key}`);
problems.push(...invalidMessages("en", en), ...invalidMessages("de", de));
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
