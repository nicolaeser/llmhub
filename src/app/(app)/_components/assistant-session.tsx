"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { buttonVariants } from "@heroui/react";
import { Sparkles } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import { consumeSseBuffer } from "@/lib/assistant/sse";
import {
  applyAssistantEvent,
  messageText,
  settleAssistantMessage,
} from "@/lib/assistant/transcript";
import type { AssistantChatMessage } from "@/types/assistant";

const STORAGE_KEY = "llmhub.assistant.model";

type AssistantSession = {
  enabled: boolean;
  messages: AssistantChatMessage[];
  pending: boolean;
  error: string;
  model: string;
  allowWrite: boolean;
  chooseModel: (models: string[], fallback: string) => void;
  setModel: (model: string) => void;
  setAllowWrite: (allow: boolean) => void;
  send: (text: string) => Promise<void>;
  stop: () => void;
  reset: () => void;
};

const AssistantSessionContext = createContext<AssistantSession | null>(null);

export function useAssistantSession() {
  return useContext(AssistantSessionContext);
}

export function AssistantTrigger() {
  const session = useAssistantSession();
  const t = useTranslations("Assistant");
  if (!session?.enabled) return null;
  return (
    <Link
      href="/assistant"
      aria-label={t("open")}
      className={buttonVariants({ size: "sm", variant: "ghost" })}
    >
      <Sparkles size={14} aria-hidden />
      <span className="hidden sm:inline">{t("title")}</span>
    </Link>
  );
}

export default function AssistantProvider({
  enabled = true,
  children,
}: {
  enabled?: boolean;
  children?: ReactNode;
}) {
  const locale = useLocale();
  const [messages, setMessages] = useState<AssistantChatMessage[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [model, setModelState] = useState("");
  const [allowWrite, setAllowWrite] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const chooseModel = useCallback((models: string[], fallback: string) => {
    let stored = "";
    try {
      stored = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      stored = "";
    }
    setModelState((current) => {
      if (models.includes(current)) return current;
      if (models.includes(stored)) return stored;
      if (models.includes(fallback)) return fallback;
      return models[0] ?? "";
    });
  }, []);

  function setModel(next: string) {
    setModelState(next);
    if (!next) return;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {}
  }

  function patchLast(
    update: (message: AssistantChatMessage) => AssistantChatMessage | null,
  ) {
    setMessages((prev) => {
      const last = prev.at(-1);
      if (last?.role !== "assistant") return prev;
      const next = update(last);
      return next ? [...prev.slice(0, -1), next] : prev.slice(0, -1);
    });
  }

  function finish(controller: AbortController) {
    if (abortRef.current !== controller) return;
    abortRef.current = null;
    setPending(false);
    patchLast((last) =>
      last.parts.length ? settleAssistantMessage(last) : null,
    );
  }

  function stop() {
    const controller = abortRef.current;
    if (!controller) return;
    finish(controller);
    controller.abort();
  }

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPending(false);
    setMessages([]);
    setError("");
  }

  async function send(text: string) {
    const content = text.trim().slice(0, 8000);
    if (!content || pending) return;
    setError("");
    const history: AssistantChatMessage[] = [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: "user",
        parts: [{ type: "text", text: content }],
      },
    ];
    setMessages([
      ...history,
      { id: crypto.randomUUID(), role: "assistant", parts: [] },
    ]);
    setPending(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch("/internal-api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          locale,
          model,
          write: allowWrite,
          messages: history
            .map((row) => ({ role: row.role, content: messageText(row) }))
            .filter((row) => row.content),
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const problem = (await res.json().catch(() => null)) as { code?: string } | null;
        throw new Error(problem?.code || "llm_failed");
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("llm_failed");
      const decoder = new TextDecoder();
      let leftover = "";
      for (;;) {
        const { done, value } = await reader.read();
        leftover += decoder.decode(value, { stream: !done });
        const pulled = consumeSseBuffer(leftover, done);
        leftover = pulled.rest;
        for (const event of pulled.events) {
          if (event.type === "error") throw new Error(event.message);
          if (abortRef.current !== controller) break;
          patchLast((last) => applyAssistantEvent(last, event));
        }
        if (done) break;
      }
    } catch (err) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setError(err instanceof Error ? err.message : "llm_failed");
    } finally {
      finish(controller);
    }
  }

  return (
    <AssistantSessionContext.Provider
      value={{
        enabled,
        messages,
        pending,
        error,
        model,
        allowWrite,
        chooseModel,
        setModel,
        setAllowWrite,
        send,
        stop,
        reset,
      }}
    >
      {children}
    </AssistantSessionContext.Provider>
  );
}
