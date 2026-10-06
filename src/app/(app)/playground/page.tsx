"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Button, Card, Spinner, toast } from "@heroui/react";
import { PlayCircle, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { Link } from "@/i18n/routing";
import { loadAliasesAction } from "@/app/(app)/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { Msg, Session } from "@/types/playground";
import {
  STORAGE_KEY,
  makeSession,
  parseSessions,
  parseTools,
  readAssistantStream,
  titleFrom,
} from "./_components/chat-session";
import SessionSidebar, { SessionPicker } from "./_components/session-nav";
import ChatSettings from "./_components/chat-settings";
import ChatTranscript from "./_components/chat-transcript";
import ChatComposer from "./_components/chat-composer";

export default function PlaygroundPage() {
  const t = useTranslations("Playground");
  const tCommon = useTranslations("Common");
  const [models, setModels] = useState<string[]>([]);
  const [providerCount, setProviderCount] = useState(0);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [input, setInput] = useState("");
  const [toolsJson, setToolsJson] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, start] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0];
  const model = current?.model ?? "";
  const msgs = current?.messages ?? [];
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  useEffect(() => {
    let stored: Session[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = parseSessions(raw);
    } catch {
      stored = [];
    }
    loadAliasesAction().then((res) => {
      const aliases = isActionFail(res) ? [] : res.models;
      setModels(aliases);
      setProviderCount(isActionFail(res) ? 0 : res.providers);
      const fallback = aliases[0] ?? "";
      if (stored.length === 0) {
        const created = makeSession(fallback);
        setSessions([created]);
        setCurrentId(created.id);
      } else {
        const hydrated = stored.map((s) => ({
          ...s,
          model: s.model || fallback,
        }));
        setSessions(hydrated);
        const newest = [...hydrated].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        setCurrentId(newest?.id ?? hydrated[0]!.id);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (loading || pending) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      toast.danger(t("storageError"));
    }
  }, [sessions, loading, pending, t]);

  function patchSession(id: string, patch: Partial<Session>) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s,
      ),
    );
  }

  function selectSession(id: string) {
    if (pending) return;
    setCurrentId(id);
    setImages([]);
  }

  function createSession() {
    if (pending) return;
    const created = makeSession(model || models[0] || "");
    setSessions((prev) => [created, ...prev]);
    setCurrentId(created.id);
    setImages([]);
  }

  function removeSession(id: string) {
    if (pending) return;
    const remaining = sessions.filter((s) => s.id !== id);
    if (remaining.length === 0) {
      const created = makeSession(models[0] || "");
      setSessions([created]);
      setCurrentId(created.id);
      setImages([]);
      return;
    }
    setSessions(remaining);
    if (id === currentId) setCurrentId(remaining[0]!.id);
    setImages([]);
  }

  function send() {
    const text = input.trim();
    if ((!text && images.length === 0) || !model || !current || pending) return;
    const tools = parseTools(toolsJson);
    if (tools === "error") {
      toast.danger(t("toolsError"));
      return;
    }
    const content: Msg["content"] =
      images.length === 0
        ? text
        : [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...images.map((url) => ({
              type: "image_url" as const,
              image_url: { url },
            })),
          ];
    const sessionId = current.id;
    const next: Msg[] = [...msgs, { role: "user", content }];
    const title = current.title || titleFrom(next);
    patchSession(sessionId, {
      title,
      messages: [...next, { role: "assistant", content: "" }],
    });
    setInput("");
    setImages([]);
    start(async () => {
      try {
        const res = await fetch("/internal-api/playground/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            messages: next,
            stream: true,
            ...(tools ? { tools } : {}),
          }),
        });
        if (!res.ok) {
          const problem = (await res.json().catch(() => ({}))) as { detail?: string };
          throw new Error(problem.detail || t("error"));
        }
        const assistant = await readAssistantStream(res, (textSoFar) => {
          patchSession(sessionId, {
            title,
            messages: [...next, { role: "assistant", content: textSoFar }],
          });
          bottom.current?.scrollIntoView({ behavior: "smooth" });
        });
        patchSession(sessionId, {
          title,
          messages: [
            ...next,
            {
              role: "assistant",
              content: assistant || t("emptyResponse"),
            },
          ],
        });
      } catch (err) {
        toast.danger(err instanceof Error ? err.message : t("error"));
        patchSession(sessionId, { title, messages: next });
      } finally {
        bottom.current?.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  if (!models.length) {
    const gap = providerCount === 0 ? "provider" : "model";
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <EmptyState
          icon={PlayCircle}
          title={t("emptySetupTitle")}
          description={t.rich("emptySetup", {
            gap,
            providers: (chunks) => (
              <Link href="/providers" className="text-accent">
                {chunks}
              </Link>
            ),
            models: (chunks) => (
              <Link href="/models" className="text-accent">
                {chunks}
              </Link>
            ),
          })}
          action={
            <Link
              href={gap === "provider" ? "/providers" : "/models"}
              className="text-sm font-medium text-accent"
            >
              {t("emptySetupAction", { gap })}
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-[70vh] flex-col md:h-[calc(100vh-7rem)]">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button
            variant="secondary"
            aria-label={t("newSession")}
            isDisabled={pending}
            onPress={createSession}
          >
            <Plus size={14} aria-hidden />
            {t("newSession")}
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <SessionSidebar
          sessions={ordered}
          currentId={current?.id}
          pending={pending}
          onSelect={selectSession}
          onRemove={removeSession}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionPicker
            sessions={ordered}
            currentId={current?.id}
            pending={pending}
            onSelect={selectSession}
            onRemove={removeSession}
          />
          <ChatSettings
            models={models}
            model={model}
            toolsJson={toolsJson}
            pending={pending}
            onModelChange={(next) => {
              if (current) patchSession(current.id, { model: next });
            }}
            onToolsChange={setToolsJson}
            onClear={() => current && patchSession(current.id, { messages: [], title: "" })}
          />
          <Card className="min-h-0 flex-1 gap-0 p-0">
            <ChatTranscript messages={msgs} pending={pending} bottomRef={bottom} />
            <ChatComposer
              input={input}
              images={images}
              pending={pending}
              canSend={Boolean(model)}
              onInputChange={setInput}
              onAddImages={(urls) => setImages((prev) => [...prev, ...urls])}
              onRemoveImage={(index) =>
                setImages((prev) => prev.filter((_, idx) => idx !== index))
              }
              onSend={send}
            />
          </Card>
        </div>
      </div>
    </div>
  );
}
