"use client";

import { useEffect, useRef } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import Markdown from "@/components/console/markdown";
import { groupAssistantParts, messageText } from "@/lib/assistant/transcript";
import type { AssistantChatMessage } from "@/types/assistant";
import ToolCalls from "./tool-calls";

function AssistantAvatar() {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-full bg-accent/10 text-accent">
      <Sparkles size={14} aria-hidden />
    </div>
  );
}

function AssistantReply({
  message,
  working,
}: {
  message: AssistantChatMessage;
  working: boolean;
}) {
  const t = useTranslations("Assistant");
  const text = messageText(message);
  const toolRunning = message.parts.some(
    (part) => part.type === "tool" && part.status === "running",
  );
  return (
    <div className="flex gap-3">
      <AssistantAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-3 pt-0.5">
        {groupAssistantParts(message).map((group) =>
          group.type === "text" ? (
            <Markdown key={group.key} text={group.text} />
          ) : (
            <ToolCalls key={group.key} tools={group.tools} />
          ),
        )}
        {working && !toolRunning ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner size="sm" color="current" />
            {t("thinking")}
          </div>
        ) : null}
        {!working && text ? (
          <div className="flex">
            <CopyButton text={text} label={t("copyMessage")} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function AssistantTranscript({
  messages,
  pending,
  error,
  onSuggest,
}: {
  messages: AssistantChatMessage[];
  pending: boolean;
  error: string;
  onSuggest: (text: string) => void;
}) {
  const t = useTranslations("Assistant");
  const pane = useRef<HTMLDivElement>(null);

  const suggestions = [
    { id: "setup", label: t("suggestions.setup") },
    { id: "keys", label: t("suggestions.keys") },
    { id: "usage", label: t("suggestions.usage") },
    { id: "playground", label: t("suggestions.playground") },
  ] as const;

  useEffect(() => {
    const node = pane.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, pending, error]);

  return (
    <div
      ref={pane}
      role="log"
      aria-label={t("transcript")}
      className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6"
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center gap-5 py-10 text-center">
            <div className="grid size-12 place-items-center rounded-xl bg-accent/10 text-accent">
              <Sparkles size={20} aria-hidden />
            </div>
            <div className="max-w-md">
              <p className="text-base font-semibold tracking-tight text-foreground">
                {t("emptyTitle")}
              </p>
              <p className="mt-1 text-sm text-muted">{t("emptyHint")}</p>
            </div>
            <div className="grid w-full max-w-xl gap-2 sm:grid-cols-2">
              {suggestions.map((item) => (
                <Button
                  key={item.id}
                  variant="secondary"
                  fullWidth
                  className="justify-start text-left whitespace-normal"
                  isDisabled={pending}
                  onPress={() => onSuggest(item.label)}
                >
                  {item.label}
                </Button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((message, index) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl bg-accent px-3.5 py-2.5 text-sm whitespace-pre-wrap break-words text-accent-foreground">
                  {messageText(message)}
                </div>
              </div>
            ) : (
              <AssistantReply
                key={message.id}
                message={message}
                working={pending && index === messages.length - 1}
              />
            ),
          )
        )}
        {error ? (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Description>{t("error", { code: error })}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
      </div>
    </div>
  );
}
