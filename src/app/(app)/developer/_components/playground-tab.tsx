"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Alert, Card, toast } from "@heroui/react";
import { PlayCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import { Link } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type { PlaygroundMessage, PlaygroundSession } from "@/types/playground";
import { loadAliasesAction, loadReplayAction } from "../_action";
import {
  STORAGE_KEY,
  makeSession,
  parseSessions,
  parseTools,
  readAssistantStream,
  replaySession,
  titleFrom,
} from "./chat-session";
import SessionSidebar, { SessionPicker } from "./session-nav";
import ChatSettings from "./chat-settings";
import ChatTranscript from "./chat-transcript";
import ChatComposer from "./chat-composer";

type ReplayNotice =
  | { kind: "failed"; sessionId: string; error: string }
  | {
      kind: "loaded";
      sessionId: string;
      id: string;
      model: string;
      dropped: boolean;
      truncated: boolean;
      masked: boolean;
    };

export default function PlaygroundTab() {
  const t = useTranslations("Playground");
  const tError = useTranslations("Error");
  const [sessions, setSessions] = useState<PlaygroundSession[]>([]);
  const [currentId, setCurrentId] = useState("");
  const [input, setInput] = useState("");
  const [toolsJson, setToolsJson] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [replay, setReplay] = useState<ReplayNotice | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, start] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);

  const current = sessions.find((s) => s.id === currentId) ?? sessions[0];
  const model = current?.model ?? "";
  const msgs = current?.messages ?? [];
  const ordered = useMemo(
    () => [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions],
  );

  async function hydrate({ models: aliases }: { models: string[] }) {
    const params = new URLSearchParams(window.location.search);
    const replayId = params.get("replay");
    let stored: PlaygroundSession[] = [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) stored = parseSessions(raw);
    } catch {
      stored = [];
    }
    const replayed = replayId && aliases.length ? await loadReplayAction(replayId) : null;
    if (replayId) setSearchParams({ replay: null, model: null });
    const fallback = aliases[0] ?? "";
    const hydrated = stored.map((s) => ({
      ...s,
      model: s.model || fallback,
    }));
    if (replayed && !isActionFail(replayed)) {
      const requested = params.get("model") || replayed.model;
      const created = replaySession(replayed, aliases.includes(requested) ? requested : "");
      setSessions([created, ...hydrated]);
      setCurrentId(created.id);
      setInput(replayed.prompt.text);
      setImages(replayed.prompt.images);
      setToolsJson(replayed.tools.length ? JSON.stringify(replayed.tools, null, 2) : "");
      setReplay({
        kind: "loaded",
        sessionId: created.id,
        id: replayed.id,
        model: replayed.model,
        dropped: replayed.dropped,
        truncated: replayed.truncated,
        masked: replayed.masked,
      });
    } else {
      const list = hydrated.length ? hydrated : [makeSession(fallback)];
      const newest = [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
      setSessions(list);
      setCurrentId(newest.id);
      if (replayed) setReplay({ kind: "failed", sessionId: newest.id, error: replayed.error });
    }
    setReady(true);
  }

  const page = useActionData(loadAliasesAction, hydrate);
  const models = page.data?.models ?? [];
  const providerCount = page.data?.providers ?? 0;

  useEffect(() => {
    if (!ready || pending) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sessions));
    } catch {
      toast.danger(t("storageError"));
    }
  }, [sessions, ready, pending, t]);

  function patchSession(id: string, patch: Partial<PlaygroundSession>) {
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
    const content: PlaygroundMessage["content"] =
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
    const next: PlaygroundMessage[] = [...msgs, { role: "user", content }];
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
            messages: current.system.trim()
              ? [{ role: "system", content: current.system }, ...next]
              : next,
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

  if (!page.data || !ready) {
    return <PageStatus state={page} />;
  }

  if (!models.length) {
    const gap = providerCount === 0 ? "provider" : "model";
    return (
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
    );
  }

  return (
    <div className="flex min-h-[60vh] flex-col md:h-[calc(100vh-16rem)]">
      <div className="flex min-h-0 flex-1 flex-col gap-4 md:flex-row">
        <SessionSidebar
          sessions={ordered}
          currentId={current?.id}
          pending={pending}
          onSelect={selectSession}
          onRemove={removeSession}
          onCreate={createSession}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionPicker
            sessions={ordered}
            currentId={current?.id}
            pending={pending}
            onSelect={selectSession}
            onRemove={removeSession}
            onCreate={createSession}
          />
          <ChatSettings
            models={models}
            model={model}
            system={current?.system ?? ""}
            toolsJson={toolsJson}
            pending={pending}
            onModelChange={(next) => {
              if (current) patchSession(current.id, { model: next });
            }}
            onSystemChange={(next) => {
              if (current) patchSession(current.id, { system: next });
            }}
            onToolsChange={setToolsJson}
            onClear={() => current && patchSession(current.id, { messages: [], title: "" })}
          />
          {replay && replay.sessionId === current?.id ? (
            <Alert
              status={
                replay.kind === "failed"
                  ? "danger"
                  : replay.dropped || replay.truncated || replay.masked
                    ? "warning"
                    : "accent"
              }
              className="mb-3"
            >
              <Alert.Indicator />
              <Alert.Content>
                {replay.kind === "failed" ? (
                  <Alert.Description>{tError("code", { code: replay.error })}</Alert.Description>
                ) : (
                  <>
                    <Alert.Title>{t("replayTitle")}</Alert.Title>
                    <Alert.Description>{t("replayLoaded", { id: replay.id, model: replay.model })}</Alert.Description>
                    {replay.dropped ? <Alert.Description>{t("replayDropped")}</Alert.Description> : null}
                    {replay.truncated ? <Alert.Description>{t("replayTruncated")}</Alert.Description> : null}
                    {replay.masked ? <Alert.Description>{t("replayMasked")}</Alert.Description> : null}
                  </>
                )}
              </Alert.Content>
            </Alert>
          ) : null}
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
