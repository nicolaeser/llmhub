"use client";

import type { RefObject } from "react";
import { Spinner } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { Msg } from "@/types/playground";

function visibleText(content: Msg["content"], imageMarker: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const chunks: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") chunks.push(part.text);
    else if (part.type === "image_url") chunks.push(imageMarker);
  }
  return chunks.join("\n");
}

export default function ChatTranscript({
  messages,
  pending,
  bottomRef,
}: {
  messages: Msg[];
  pending: boolean;
  bottomRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useTranslations("Playground");
  return (
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5" aria-live="polite">
      {messages.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <p className="text-sm font-medium">{t("emptyTitle")}</p>
          <p className="mt-1 text-sm text-muted">{t("emptyHint")}</p>
        </div>
      ) : (
        messages.map((m, i) => {
          const text = visibleText(m.content, t("imageMarker"));
          return (
            <div
              key={i}
              className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm ${m.role === "user" ? "bg-accent text-accent-foreground" : "bg-surface-secondary"}`}
              >
                {text || (pending ? <Spinner size="sm" color="current" /> : "")}
              </div>
            </div>
          );
        })
      )}
      <div ref={bottomRef} />
    </div>
  );
}
