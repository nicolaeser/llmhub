import "server-only";
import { asRecord, asString } from "@/lib/gateway/core";
import { claudeCodeSession } from "@/lib/gateway/protocols/messages";
import {
  CLAUDE_CODE_SESSION_HEADER,
  clientSessionKey,
  MAX_SESSION_LENGTH,
} from "@/lib/gateway/routing/account-affinity";
import type { RequestClient } from "@/types/gateway";

export const SESSION_HEADER = "x-llmhub-session";
export const AGENT_HEADER = "x-llmhub-agent";
const CODEX_SESSION_HEADER = "session_id";
const AGENT_LENGTH = 40;
const AGENT_UNSAFE = /[^a-z0-9._-]+/g;
const AGENT_EDGES = /^[._-]+|[._-]+$/g;
const CLAUDE_CODE_USER_AGENT = /^claude-cli\//i;
const CODEX_CLIENT = /^codex/i;

function sessionValue(value: unknown): string {
  const text = asString(value).trim();
  return text.length > MAX_SESSION_LENGTH ? "" : text;
}

export function agentName(value: string): string {
  return value.trim().toLowerCase().replace(AGENT_UNSAFE, "_").replace(AGENT_EDGES, "").slice(0, AGENT_LENGTH);
}

function metadataOf(body: unknown) {
  return asRecord(asRecord(body)?.metadata);
}

function detectedAgent(headers: Headers, body: unknown): string {
  const named = agentName(headers.get(AGENT_HEADER) ?? "");
  if (named) return named;
  const userAgent = headers.get("user-agent") ?? "";
  if (
    CLAUDE_CODE_USER_AGENT.test(userAgent) ||
    headers.has(CLAUDE_CODE_SESSION_HEADER) ||
    claudeCodeSession(metadataOf(body)?.user_id)
  ) {
    return "claude_code";
  }
  if (CODEX_CLIENT.test(headers.get("originator") ?? "") || CODEX_CLIENT.test(userAgent)) return "codex";
  return "";
}

export function requestClient(headers: Headers, body?: unknown): RequestClient {
  const claudeHeader = { [CLAUDE_CODE_SESSION_HEADER]: headers.get(CLAUDE_CODE_SESSION_HEADER) ?? "" };
  const session =
    sessionValue(headers.get(SESSION_HEADER)) ||
    clientSessionKey(body, claudeHeader) ||
    sessionValue(metadataOf(body)?.session_id) ||
    sessionValue(headers.get(CODEX_SESSION_HEADER));
  return { session, agent: detectedAgent(headers, body) };
}
