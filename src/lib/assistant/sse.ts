import type { AssistantEvent } from "@/types/assistant";

function parseAssistantSseLine(line: string): AssistantEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return null;
  const data = trimmed.slice(5).trim();
  if (!data) return null;
  try {
    const parsed = JSON.parse(data) as AssistantEvent;
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function consumeSseBuffer(
  buffer: string,
  flush = false,
): { events: AssistantEvent[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = flush ? "" : (parts.pop() ?? "");
  const events: AssistantEvent[] = [];
  for (const line of parts) {
    const event = parseAssistantSseLine(line);
    if (event) events.push(event);
  }
  return { events, rest };
}
