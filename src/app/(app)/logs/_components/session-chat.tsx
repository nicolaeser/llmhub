"use client";

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Alert, Button, Card, Chip, Disclosure, Separator } from "@heroui/react";
import {
  ArrowDown,
  Brain,
  FileText,
  Image as ImageGlyph,
  Music,
  Paperclip,
  RefreshCw,
  ScrollText,
  Wrench,
  MessagesSquare,
  type LucideIcon,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { cacheHitRate } from "@/lib/usage/usage-stats";
import type { LogChatRequest, LogChatThread, LogChatTurn, LogSessionRef, TranscriptEntry } from "@/types/logs";
import { loadLogSessionChatAction } from "../_action";
import Markdown from "./markdown";
import { PiiCode } from "./pii-placeholder";
import { AgentTile, useCompactTokens } from "./session-cells";
import { useLiveReload } from "./use-live-reload";

const CLIENT_CLOSED = 499;
const PREVIEW_CHARS = 80;
const MEDIA_ICONS: Record<string, LucideIcon> = { image: ImageGlyph, audio: Music, file: FileText };

type Item =
  | { type: "resent"; key: string; request: LogChatRequest }
  | { type: "entry"; key: string; entry: TranscriptEntry; avatar: boolean }
  | { type: "error"; key: string; request: LogChatRequest }
  | { type: "footer"; key: string; request: LogChatRequest };

function fromUser(entry: TranscriptEntry): boolean {
  return entry.role === "user" && entry.kind !== "tool_result";
}

function failed(request: LogChatRequest): boolean {
  return request.status >= 400 && request.status !== CLIENT_CLOSED;
}

function itemsOf(turns: LogChatTurn[]): Item[] {
  const items: Item[] = [];
  let agentSpeaking = false;
  for (const turn of turns) {
    const { request } = turn;
    if (request.resent > 0) items.push({ type: "resent", key: `${request.id}:resent`, request });
    const entries = [...turn.input, ...turn.output];
    entries.forEach((entry, index) => {
      const agent = !fromUser(entry);
      items.push({ type: "entry", key: `${request.id}:${index}`, entry, avatar: agent && !agentSpeaking });
      agentSpeaking = agent;
    });
    if (failed(request)) items.push({ type: "error", key: `${request.id}:error`, request });
    items.push({ type: "footer", key: `${request.id}:footer`, request });
  }
  return items;
}

function Row({ avatar, agent, children }: { avatar: boolean; agent: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-7 shrink-0">{avatar ? <AgentTile agent={agent} active={false} size="sm" /> : null}</div>
      <div className="min-w-0 flex-1 space-y-2">{children}</div>
    </div>
  );
}

function Fold({
  icon: Icon,
  label,
  chip,
  preview,
  children,
}: {
  icon: LucideIcon;
  label: string;
  chip?: string;
  preview?: string;
  children: ReactNode;
}) {
  return (
    <Card variant="tertiary" className="gap-0 px-3 py-2">
      <Disclosure>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-2 text-left text-xs text-muted">
            <Icon size={14} aria-hidden className="shrink-0" />
            <span className="shrink-0 font-medium text-foreground">{label}</span>
            {chip ? (
              <Chip size="sm" variant="soft" className="max-w-48 truncate font-mono">
                {chip}
              </Chip>
            ) : null}
            {preview ? <span className="min-w-0 flex-1 truncate font-mono">{preview}</span> : <span className="flex-1" />}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="pt-2">{children}</Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </Card>
  );
}

function Attachment({ entry }: { entry: TranscriptEntry }) {
  const t = useTranslations("Logs.detail");
  const Icon = MEDIA_ICONS[entry.text] ?? Paperclip;
  return (
    <Card variant="tertiary" className="w-fit max-w-full gap-0 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <Icon size={16} aria-hidden className="shrink-0 text-accent" />
        <span className="font-medium text-foreground">{t("media", { media: entry.text })}</span>
        {entry.name ? <span className="min-w-0 truncate font-mono text-xs text-muted">{entry.name}</span> : null}
      </div>
      {entry.url ? (
        <a
          href={entry.url}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="mt-1 block text-xs break-all text-accent underline underline-offset-2"
        >
          {entry.url}
        </a>
      ) : null}
    </Card>
  );
}

function EntryView({ entry }: { entry: TranscriptEntry }) {
  const t = useTranslations("Logs.detail");
  const tChat = useTranslations("Logs.chat");
  if (entry.kind === "media") return <Attachment entry={entry} />;
  if (entry.kind === "tool_call") {
    return (
      <Fold icon={Wrench} label={tChat("toolCall")} chip={entry.name || undefined}>
        <PiiCode text={entry.text} />
      </Fold>
    );
  }
  if (entry.kind === "tool_result") {
    return (
      <Fold icon={ScrollText} label={t("toolResult")} preview={entry.text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ")}>
        <PiiCode text={entry.text} />
      </Fold>
    );
  }
  if (entry.kind === "reasoning") {
    return (
      <Fold icon={Brain} label={t("reasoning")} preview={entry.text.slice(0, PREVIEW_CHARS).replace(/\s+/g, " ")}>
        <Markdown text={entry.text} pii muted />
      </Fold>
    );
  }
  return (
    <Card variant={entry.role === "assistant" ? "default" : "secondary"} className="w-fit max-w-full gap-0 px-4 py-3">
      <Markdown text={entry.text} pii />
    </Card>
  );
}

function Resent({ request }: { request: LogChatRequest }) {
  const t = useTranslations("Logs.chat");
  const rate = Math.min(1, cacheHitRate(request.cacheReadTokens, request.promptTokens));
  return (
    <div className="flex items-center gap-3 py-1">
      <Separator className="flex-1" />
      <Chip size="sm" variant="soft" className="max-w-full">
        <RefreshCw size={12} aria-hidden />
        {t("resent", { count: request.resent, cached: String(rate > 0), rate })}
      </Chip>
      <Separator className="flex-1" />
    </div>
  );
}

function Footer({ request, onOpen }: { request: LogChatRequest; onOpen: (id: string) => void }) {
  const t = useTranslations("Logs");
  const tChat = useTranslations("Logs.chat");
  const format = useFormatter();
  const tokens = useCompactTokens();
  const rate = Math.min(1, cacheHitRate(request.cacheReadTokens, request.promptTokens));
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-10 text-xs text-muted">
      <time dateTime={request.createdAt} title={format.dateTime(new Date(request.createdAt), "zoned")}>
        {format.dateTime(new Date(request.createdAt), "time")}
      </time>
      <span className="font-mono">{request.model}</span>
      <span>{t("latencyMs", { value: request.latencyMs })}</span>
      <span>{tokens(request.promptTokens, request.completionTokens)}</span>
      <span>{format.number(request.cost, "money")}</span>
      {rate > 0 ? (
        <Chip size="sm" variant="soft" color="success">
          {tChat("cached", { rate })}
        </Chip>
      ) : null}
      {request.outcome === "cache_hit" ? (
        <Chip size="sm" variant="soft" color="accent">
          {tChat("cacheHit")}
        </Chip>
      ) : null}
      {request.repeated ? (
        <Chip size="sm" variant="soft">
          {tChat("repeated")}
        </Chip>
      ) : null}
      <Button
        isIconOnly
        size="sm"
        variant="ghost"
        aria-label={t("openDetails", { model: request.model })}
        onPress={() => onOpen(request.id)}
      >
        <FileText size={14} aria-hidden />
      </Button>
    </div>
  );
}

function Thread({ thread, agent, onOpen }: { thread: LogChatThread; agent: string; onOpen: (id: string) => void }) {
  const t = useTranslations("Logs.chat");
  const items = useMemo(() => itemsOf(thread.turns), [thread.turns]);
  return (
    <div className="space-y-3">
      {thread.system.length ? (
        <Fold icon={ScrollText} label={t("systemPrompt")}>
          <div className="space-y-3">
            {thread.system.map((entry, index) => (
              <Markdown key={index} text={entry.text} pii muted />
            ))}
          </div>
        </Fold>
      ) : null}
      {items.map((item) => {
        if (item.type === "resent") return <Resent key={item.key} request={item.request} />;
        if (item.type === "footer") return <Footer key={item.key} request={item.request} onOpen={onOpen} />;
        if (item.type === "error") {
          return (
            <Alert key={item.key} status="danger">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>{item.request.error || String(item.request.status)}</Alert.Description>
              </Alert.Content>
            </Alert>
          );
        }
        if (fromUser(item.entry)) {
          return (
            <div key={item.key} className="flex justify-end">
              <div className="min-w-0 max-w-[85%] space-y-2">
                <EntryView entry={item.entry} />
              </div>
            </div>
          );
        }
        return (
          <Row key={item.key} avatar={item.avatar} agent={agent}>
            <EntryView entry={item.entry} />
          </Row>
        );
      })}
    </div>
  );
}

export default function SessionChat({
  sessionRef,
  agent,
  active,
  onOpenRequest,
}: {
  sessionRef: LogSessionRef;
  agent: string;
  active: boolean;
  onOpenRequest: (id: string) => void;
}) {
  const t = useTranslations("Logs.chat");
  const tDetail = useTranslations("Logs.detail");
  const tSessions = useTranslations("Logs.sessions");
  const bottomRef = useRef<HTMLDivElement>(null);
  const state = useActionData(() => loadLogSessionChatAction({ ref: sessionRef }));
  const { data, pending, setData } = state;

  const refresh = useCallback(() => {
    loadLogSessionChatAction({ ref: sessionRef }).then((res) => {
      if (!isActionFail(res)) setData(res);
    });
  }, [sessionRef, setData]);
  useLiveReload(active && !pending, refresh);

  if (!data) {
    return state.error ? <LoadError state={state} /> : <SectionLoading shape="details" />;
  }

  if (!data.canViewContent) {
    return (
      <Alert status="default">
        <Alert.Indicator />
        <Alert.Content>
          <Alert.Description>{tDetail("noPermission")}</Alert.Description>
        </Alert.Content>
      </Alert>
    );
  }

  if (!data.threads.length) {
    return <EmptyState icon={MessagesSquare} title={t("empty")} description={t("emptyHint")} />;
  }

  const ordered = [...data.threads].sort((a, b) => b.turns.length - a.turns.length);
  const [main, ...side] = ordered;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <LoadError state={state} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{tSessions("requestCount", { count: data.scanned })}</p>
        <Button size="sm" variant="secondary" onPress={() => bottomRef.current?.scrollIntoView({ block: "end" })}>
          <ArrowDown size={14} aria-hidden />
          {t("jump")}
        </Button>
      </div>
      {data.scanned < data.total ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("partial", { scanned: data.scanned, total: data.total })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Thread thread={main!} agent={agent} onOpen={onOpenRequest} />
      {side.length ? (
        <section className="space-y-3" aria-label={t("sideTitle", { count: side.length })}>
          <Separator />
          <h2 className="text-sm font-semibold">{t("sideTitle", { count: side.length })}</h2>
          {side.map((thread, index) => (
            <Card key={thread.id} variant="secondary" className="gap-0 px-4 py-2">
              <Disclosure>
                <Disclosure.Heading>
                  <Disclosure.Trigger className="flex w-full min-w-0 items-center gap-2 text-left text-sm">
                    <span className="font-medium text-foreground">{t("sideItem", { index: index + 1 })}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted">
                      {t("sideMeta", { count: thread.turns.length, models: thread.models.join(", ") })}
                    </span>
                    <Disclosure.Indicator />
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="py-3">
                    <Thread thread={thread} agent={agent} onOpen={onOpenRequest} />
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </Card>
          ))}
        </section>
      ) : null}
      <div ref={bottomRef} />
    </div>
  );
}
