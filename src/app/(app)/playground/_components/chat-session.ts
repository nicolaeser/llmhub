import type { Msg, Session } from "@/types/playground";

export const STORAGE_KEY = "llmhub.playground.sessions";

export function makeSession(model: string): Session {
  return {
    id: crypto.randomUUID(),
    title: "",
    model,
    messages: [],
    updatedAt: Date.now(),
  };
}

function isMsg(value: unknown): value is Msg {
  if (!value || typeof value !== "object") return false;
  const row = value as { role?: unknown; content?: unknown };
  if (row.role !== "user" && row.role !== "assistant") return false;
  return typeof row.content === "string" || Array.isArray(row.content);
}

export function parseSessions(raw: string): Session[] {
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) return [];
  const out: Session[] = [];
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.updatedAt !== "number") continue;
    out.push({
      id: row.id,
      title: typeof row.title === "string" ? row.title : "",
      model: typeof row.model === "string" ? row.model : "",
      messages: Array.isArray(row.messages) ? row.messages.filter(isMsg) : [],
      updatedAt: row.updatedAt,
    });
  }
  return out;
}

export function titleFrom(messages: Msg[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) return "";
  if (typeof first.content === "string") return first.content.trim().slice(0, 48);
  const text = first.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join(" ")
    .trim();
  return text.slice(0, 48);
}

export function parseTools(raw: string): unknown[] | undefined | "error" {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : "error";
  } catch {
    return "error";
  }
}

export async function readAssistantStream(
  res: Response,
  onUpdate: (text: string) => void,
): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("stream");
  const decoder = new TextDecoder();
  let assistant = "";
  let leftover = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    leftover += decoder.decode(value, { stream: true });
    const parts = leftover.split("\n");
    leftover = parts.pop() ?? "";
    for (const line of parts) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const json = JSON.parse(data) as {
          choices?: { delta?: { content?: string }; message?: { content?: string } }[];
        };
        assistant +=
          json.choices?.[0]?.delta?.content ||
          json.choices?.[0]?.message?.content ||
          "";
        onUpdate(assistant);
      } catch {
        continue;
      }
    }
  }
  return assistant;
}
