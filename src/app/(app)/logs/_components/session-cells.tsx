"use client";

import { Chip, Meter } from "@heroui/react";
import { ArrowLeftRight, Bot, CodeXml, SquareTerminal, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import IconTile from "@/components/console/icon-tile";
import { cacheHitRate } from "@/lib/usage/usage-stats";
import type { ReactNode } from "react";
import type { LogSessionModel, LogSessionRow } from "@/types/logs";
import { useSessionFormat } from "./session-format";

const SHOWN_MODELS = 2;
const SHORT_ID = 20;
const AGENT_ICONS: Record<string, LucideIcon> = {
  claude_code: SquareTerminal,
  codex: CodeXml,
};

export function shortId(id: string): string {
  return id.length <= SHORT_ID ? id : `${id.slice(0, SHORT_ID - 9)}…${id.slice(-8)}`;
}

function successColor(row: { requests: number; errors: number }): "success" | "warning" | "danger" {
  if (!row.errors) return "success";
  return row.errors / Math.max(1, row.requests) <= 0.1 ? "warning" : "danger";
}

export function ActiveChip({ active }: { active: boolean }) {
  const t = useTranslations("Logs.sessions");
  if (!active) return null;
  return (
    <Chip size="sm" variant="soft" color="success">
      {t("active")}
    </Chip>
  );
}

export function useCallerLabels() {
  const t = useTranslations("Logs");
  const tCommon = useTranslations("Common");
  return {
    key: (row: { keyId: string; keyLabel: string }) =>
      row.keyLabel || (row.keyId ? t("deleted", { kind: "key" }) : t("caller.noKey")),
    person: (row: { userId: string; userLabel: string; memberId: string; memberLabel: string }) =>
      row.memberLabel ||
      row.userLabel ||
      (row.memberId ? t("deleted", { kind: "member" }) : row.userId ? t("deleted", { kind: "user" }) : tCommon("none")),
  };
}

export function AgentTile({ agent, active, size = "sm" }: { agent: string; active: boolean; size?: "sm" | "md" }) {
  return <IconTile icon={AGENT_ICONS[agent] ?? Bot} tone={active ? "success" : "accent"} size={size} />;
}

export function SessionIdentity({ row, action }: { row: LogSessionRow; action?: ReactNode }) {
  const t = useTranslations("Logs.sessions");
  const session = useSessionFormat();
  const caller = useCallerLabels();
  return (
    <div className="flex min-w-0 items-start gap-3">
      <AgentTile agent={row.agent} active={row.active} />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{session.title(row.agent)}</span>
          <ActiveChip active={row.active} />
        </div>
        <div className="flex min-w-0 items-center gap-1">
          <code title={row.sessionId} className="font-mono text-xs whitespace-nowrap text-muted">
            {shortId(row.sessionId)}
          </code>
          <CopyButton text={row.sessionId} label={t("copy")} />
        </div>
        <span className="block text-xs break-words text-muted">
          {t("callerLine", {
            key: caller.key(row),
            person: caller.person(row),
          })}
        </span>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function ActivityCell({ row, now }: { row: LogSessionRow; now: Date }) {
  const t = useTranslations("Logs.sessions");
  const format = useFormatter();
  const session = useSessionFormat();
  const lastAt = new Date(row.lastAt);
  return (
    <div className="min-w-36">
      <time
        dateTime={row.lastAt}
        title={format.dateTime(lastAt, "zoned")}
        className="block text-sm whitespace-nowrap text-foreground"
      >
        {format.relativeTime(lastAt, now)}
      </time>
      <span className="block text-xs text-muted">
        {t("span", {
          start: format.dateTime(new Date(row.startedAt), "stamp"),
          duration: session.duration(row.durationMs),
        })}
      </span>
    </div>
  );
}

export function RequestsCell({ row }: { row: LogSessionRow }) {
  const t = useTranslations("Logs.sessions");
  const format = useFormatter();
  const success = row.requests ? (row.requests - row.errors) / row.requests : 1;
  const cached = Math.min(1, cacheHitRate(row.cacheReadTokens, row.promptTokens));
  const tokens = format.number(row.promptTokens + row.completionTokens, { notation: "compact", maximumFractionDigits: 1 });
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium tabular-nums text-foreground">
          {t("requestCount", { count: row.requests })}
        </span>
        <span className={row.errors ? "text-xs text-danger" : "text-xs text-muted"}>
          {t("errorCount", { count: row.errors })}
        </span>
      </div>
      <Meter
        size="sm"
        value={success * 100}
        color={successColor(row)}
        aria-label={t("columns.requests")}
        valueLabel={t("successShare", { rate: success })}
      >
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
      <span className="block text-xs text-muted">
        {t("tokenTotal", { tokens, cached: String(cached > 0), rate: cached })}
      </span>
    </div>
  );
}

export function CostCell({ row, max }: { row: LogSessionRow; max: number }) {
  const t = useTranslations("Logs.sessions");
  const tLogs = useTranslations("Logs");
  const format = useFormatter();
  const share = max > 0 ? row.cost / max : 0;
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium tabular-nums text-foreground">{format.number(row.cost, "money")}</span>
        <span className="text-xs text-muted">
          {t("perRequest", {
            value: format.number(row.cost / Math.max(1, row.requests), "money"),
          })}
        </span>
      </div>
      <Meter
        size="sm"
        value={share * 100}
        aria-label={tLogs("columns.cost")}
        valueLabel={t("costShare", { rate: share })}
      >
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
    </div>
  );
}

export function useCompactTokens() {
  const t = useTranslations("Logs.sessions");
  const format = useFormatter();
  const compact = (value: number) => format.number(value, { notation: "compact", maximumFractionDigits: 1 });
  return (input: number, output: number) => t("tokenFlow", { input: compact(input), output: compact(output) });
}

export function ModelChips({ models }: { models: LogSessionModel[] }) {
  const t = useTranslations("Logs.sessions");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  if (!models.length) return <span className="text-sm text-muted">{tCommon("none")}</span>;
  const shown = models.slice(0, SHOWN_MODELS);
  const hidden = models.slice(SHOWN_MODELS);
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {shown.map((model) => (
        <Chip key={model.model} size="sm" variant="soft">
          {model.model}
        </Chip>
      ))}
      {hidden.length ? (
        <Chip size="sm" variant="soft">
          <span
            title={format.list(
              hidden.map((model) => model.model),
              "enumeration",
            )}
          >
            {t("moreModels", { count: hidden.length })}
          </span>
        </Chip>
      ) : null}
    </div>
  );
}

export function SwitchesCell({ row }: { row: LogSessionRow }) {
  const t = useTranslations("Logs.sessions");
  return (
    <div className="min-w-0 space-y-1">
      {row.accountSwitches ? (
        <Chip size="sm" variant="soft" color="warning" className="whitespace-nowrap">
          <ArrowLeftRight size={12} aria-hidden />
          {t("switchCount", { count: row.accountSwitches })}
        </Chip>
      ) : (
        <span className="block text-sm text-muted">{t("switchCount", { count: 0 })}</span>
      )}
      <span className="block text-xs text-muted">{t("accountCount", { count: row.accounts })}</span>
    </div>
  );
}
