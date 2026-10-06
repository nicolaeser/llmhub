"use client";

import { useEffect, useRef } from "react";
import { Button, Separator, TextArea } from "@heroui/react";
import { Lock, PencilLine, Send, Square } from "lucide-react";
import { useTranslations } from "next-intl";

export default function AssistantComposer({
  value,
  pending,
  allowWrite,
  onChange,
  onSend,
  onStop,
}: {
  value: string;
  pending: boolean;
  allowWrite: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const t = useTranslations("Assistant");
  const input = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <>
      <Separator />
      <form
        className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3 sm:px-6"
        aria-label={t("send")}
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <div className="flex items-end gap-2">
          <TextArea
            ref={input}
            aria-label={t("placeholder")}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={t("placeholder")}
            className="min-h-12 flex-1"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                onSend();
              }
            }}
          />
          {pending ? (
            <Button
              isIconOnly
              variant="secondary"
              aria-label={t("stop")}
              onPress={onStop}
            >
              <Square size={16} aria-hidden />
            </Button>
          ) : (
            <Button
              type="submit"
              isIconOnly
              isDisabled={!value.trim()}
              aria-label={t("send")}
            >
              <Send size={16} aria-hidden />
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-xs text-muted">
          <span
            className={`flex items-center gap-1.5 ${allowWrite ? "text-warning" : ""}`}
          >
            {allowWrite ? (
              <PencilLine size={14} aria-hidden />
            ) : (
              <Lock size={14} aria-hidden />
            )}
            {t("write.mode", { state: allowWrite ? "on" : "off" })}
          </span>
          <span className="hidden sm:inline">{t("composerHint")}</span>
        </div>
      </form>
    </>
  );
}
