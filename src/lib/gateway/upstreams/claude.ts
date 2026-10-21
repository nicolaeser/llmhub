import { asRecord } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

export const CLAUDE_CODE_VERSION = "2.1.280";
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_OAUTH_BETAS = ["claude-code-20250219", "oauth-2025-04-20"] as const;
const CLAUDE_CODE_BILLING_PREFIX = "x-anthropic-billing-header:";
const CLAUDE_CODE_SYSTEM_PREFIXES = [
  "You are Claude Code, Anthropic's official CLI for Claude",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK",
] as const;

export function claudeIdentityHeaders(): Record<string, string> {
  return {
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    "User-Agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, cli)`,
  };
}

export function withClaudeBetas(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const betas = new Set<string>(CLAUDE_OAUTH_BETAS);
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== "anthropic-beta") {
      out[key] = value;
      continue;
    }
    for (const beta of value.split(",")) {
      const trimmed = beta.trim();
      if (trimmed) betas.add(trimmed);
    }
  }
  out["anthropic-beta"] = [...betas].join(",");
  return out;
}

function systemBlocks(system: unknown): JsonMap[] {
  if (typeof system === "string") return system ? [{ type: "text", text: system }] : [];
  if (!Array.isArray(system)) return [];
  const blocks: JsonMap[] = [];
  for (const raw of system) {
    const block = asRecord(raw);
    if (block) blocks.push(block);
  }
  return blocks;
}

function blockText(block: JsonMap): string {
  return typeof block.text === "string" ? block.text.trimStart() : "";
}

export function isNativeClaudeCode(body: JsonMap): boolean {
  return systemBlocks(body.system).some((block) => {
    const text = blockText(block);
    return (
      text.startsWith(CLAUDE_CODE_BILLING_PREFIX) ||
      CLAUDE_CODE_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix))
    );
  });
}

export function withClaudeIdentity(body: JsonMap): JsonMap {
  if (isNativeClaudeCode(body)) return body;
  return { ...body, system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }, ...systemBlocks(body.system)] };
}
