import "server-only";

import type { RequestLogDocument, RequestLogDocumentEntry, RequestLogDocumentField } from "@/types/logs";

function escapeInline(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/[\\`*_[\]<>|~]/g, "\\$&");
}

function longestBacktickRun(value: string): number {
  return (value.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
}

function codeSpan(value: string): string {
  const text = value.replace(/\s*\n\s*/g, " ");
  const fence = "`".repeat(longestBacktickRun(text) + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

function codeBlock(value: string, language = ""): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(value) + 1));
  return `${fence}${language}\n${value.replace(/\n+$/, "")}\n${fence}`;
}

function quote(value: string): string {
  return value
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function fieldList(fields: RequestLogDocumentField[]): string {
  return fields
    .map((field) => `- **${escapeInline(field.label)}:** ${field.mono ? codeSpan(field.value) : escapeInline(field.value)}`)
    .join("\n");
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function entry(item: RequestLogDocumentEntry): string {
  const title = `#### ${escapeInline(item.heading ? `${item.role} · ${item.heading}` : item.role)}`;
  if (item.kind === "media") return `${title}\n\n_${escapeInline(item.text)}_`;
  if (item.kind === "tool_call" || item.kind === "tool_result") {
    return `${title}\n\n${codeBlock(item.text, isJson(item.text) ? "json" : "")}`;
  }
  if (item.kind === "reasoning") return `${title}\n\n${quote(item.text)}`;
  return `${title}\n\n${item.text.replace(/\n+$/, "")}`;
}

export function requestLogMarkdown(doc: RequestLogDocument): string {
  const parts = [`# ${escapeInline(doc.title)}`, `${escapeInline(doc.subtitle)} · **${escapeInline(doc.status)}**`];
  if (doc.error) parts.push(quote(`**${escapeInline(doc.error.label)}:** ${doc.error.text}`));
  parts.push(fieldList(doc.fields));
  parts.push(`## ${escapeInline(doc.privacy.heading)}`, fieldList(doc.privacy.fields));
  if (doc.privacy.note) parts.push(`_${escapeInline(doc.privacy.note)}_`);
  parts.push(`## ${escapeInline(doc.content.heading)}`);
  if (doc.content.truncated) parts.push(quote(escapeInline(doc.content.truncated)));
  if (doc.content.notice) {
    parts.push(escapeInline(doc.content.notice));
  } else {
    parts.push(`### ${escapeInline(doc.content.conversation)}`);
    const { input, output } = doc.content;
    if (!input.length && !output.length) parts.push(`_${escapeInline(doc.content.empty)}_`);
    parts.push(...input.map(entry));
    if (input.length && output.length) parts.push("---");
    parts.push(...output.map(entry));
    for (const payload of doc.content.payloads) {
      parts.push(
        `### ${escapeInline(payload.heading)}`,
        payload.json ? codeBlock(payload.json, "json") : `_${escapeInline(doc.content.noJson)}_`,
      );
    }
  }
  parts.push(`---\n\n_${escapeInline(doc.generated)} · ${escapeInline(doc.brand)}_`);
  return `${parts.join("\n\n")}\n`;
}
