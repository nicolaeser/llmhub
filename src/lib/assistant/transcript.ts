import type {
  AssistantChatMessage,
  AssistantEvent,
  AssistantPartGroup,
  AssistantToolPart,
} from "@/types/assistant";

function patchTool(
  message: AssistantChatMessage,
  id: string,
  patch: (part: AssistantToolPart) => AssistantToolPart,
): AssistantChatMessage {
  let found = false;
  const parts = message.parts.map((part) => {
    if (part.type !== "tool" || part.id !== id) return part;
    found = true;
    return patch(part);
  });
  return found ? { ...message, parts } : message;
}

export function applyAssistantEvent(
  message: AssistantChatMessage,
  event: AssistantEvent,
): AssistantChatMessage {
  switch (event.type) {
    case "text": {
      if (!event.delta) return message;
      const last = message.parts.at(-1);
      if (last?.type === "text") {
        return {
          ...message,
          parts: [
            ...message.parts.slice(0, -1),
            { type: "text", text: `${last.text}\n\n${event.delta}` },
          ],
        };
      }
      return {
        ...message,
        parts: [...message.parts, { type: "text", text: event.delta }],
      };
    }
    case "tool_call":
      return {
        ...message,
        parts: [
          ...message.parts,
          {
            type: "tool",
            id: event.id,
            name: event.name,
            status: "running",
            args: event.args,
          },
        ],
      };
    case "tool_result":
      return patchTool(message, event.id, (part) => ({
        ...part,
        status: event.status,
        result: event.result,
        href: event.href,
      }));
    case "secret":
      return patchTool(message, event.id, (part) => ({
        ...part,
        secret: event.value,
      }));
    default:
      return message;
  }
}

export function settleAssistantMessage(
  message: AssistantChatMessage,
): AssistantChatMessage {
  if (!message.parts.some((part) => part.type === "tool" && part.status === "running")) {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) =>
      part.type === "tool" && part.status === "running"
        ? { ...part, status: "stopped" }
        : part,
    ),
  };
}

export function messageText(message: AssistantChatMessage): string {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
}

export function groupAssistantParts(
  message: AssistantChatMessage,
): AssistantPartGroup[] {
  const groups: AssistantPartGroup[] = [];
  message.parts.forEach((part, index) => {
    if (part.type === "text") {
      groups.push({ type: "text", key: `text-${index}`, text: part.text });
      return;
    }
    const last = groups.at(-1);
    if (last?.type === "tools") {
      last.tools.push(part);
      return;
    }
    groups.push({ type: "tools", key: `tools-${part.id}`, tools: [part] });
  });
  return groups;
}

export function toolArgsPreview(args: Record<string, unknown>): string {
  const preview = Object.values(args)
    .filter(
      (value) =>
        (typeof value === "string" && value.trim()) ||
        typeof value === "number" ||
        typeof value === "boolean",
    )
    .map((value) => String(value).trim())
    .join(" · ");
  return preview.length > 120 ? `${preview.slice(0, 119)}…` : preview;
}

export function toolErrorCode(result: unknown): string {
  if (!result || typeof result !== "object" || Array.isArray(result)) return "";
  const error = (result as { error?: unknown }).error;
  return typeof error === "string" ? error : "";
}
