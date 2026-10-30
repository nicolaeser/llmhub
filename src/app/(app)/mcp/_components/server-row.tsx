"use client";

import { Chip } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { useClock } from "@/lib/hooks/use-clock";
import type { McpServerStatus, McpServerView } from "@/types/mcp";
import { accessOf, companyConnected, enabledTools } from "./server-view";

const STATUS_COLOR = {
  connected: "success",
  error: "danger",
  disabled: "default",
  unchecked: "warning",
  signin: "warning",
} as const satisfies Record<McpServerStatus, "success" | "danger" | "warning" | "default">;

export function ServerStatusChip({ server }: { server: McpServerView }) {
  const t = useTranslations("Mcp");
  return (
    <Chip size="sm" variant="soft" color={STATUS_COLOR[server.status]}>
      {t("status", { status: server.status })}
    </Chip>
  );
}

export function ServerStatusLine({ server }: { server: McpServerView }) {
  const t = useTranslations("Mcp");
  const format = useFormatter();
  const now = useClock(60_000);
  if (server.status === "error" && server.lastError) {
    return <p className="text-xs break-words text-danger">{t("errors.code", { code: server.lastError })}</p>;
  }
  if (server.status === "signin") return <p className="text-xs text-warning">{t("list.signInHint")}</p>;
  if (server.status === "disabled") return <p className="text-xs text-muted">{t("list.disabledHint")}</p>;
  return (
    <p className="text-xs text-muted">
      {server.refreshedAt
        ? t("refreshed", { when: format.relativeTime(new Date(server.refreshedAt), now) })
        : t("neverRefreshed")}
    </p>
  );
}

export function ServerStatus({ server }: { server: McpServerView }) {
  return (
    <div className="min-w-0 space-y-1">
      <ServerStatusChip server={server} />
      <ServerStatusLine server={server} />
    </div>
  );
}

export function ServerKindChips({ server }: { server: McpServerView }) {
  const t = useTranslations("Mcp");
  return (
    <>
      {server.kind === "hosted" ? (
        <Chip size="sm" variant="soft">
          {t("hosted")}
        </Chip>
      ) : null}
      {server.template ? (
        <Chip size="sm" variant="soft">
          {t("card.template")}
        </Chip>
      ) : null}
      {server.internal ? (
        <Chip size="sm" variant="soft">
          {t("internal")}
        </Chip>
      ) : null}
    </>
  );
}

export function ServerName({ server }: { server: McpServerView }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm font-medium break-words text-foreground">{server.name}</p>
      {server.description ? <p className="text-xs break-words text-muted">{server.description}</p> : null}
      <p className="font-mono text-xs break-all text-muted">{server.url}</p>
      <div className="flex flex-wrap gap-1 empty:hidden">
        <ServerKindChips server={server} />
      </div>
    </div>
  );
}

export function ServerTools({ server }: { server: McpServerView }) {
  const t = useTranslations("Mcp");
  return (
    <span className="text-sm tabular-nums text-foreground">
      {server.toolsRestricted
        ? t("allowedCount", { allowed: enabledTools(server), count: server.tools.length })
        : t("toolCount", { count: server.tools.length })}
    </span>
  );
}

export function ServerAccess({ server, companyId }: { server: McpServerView; companyId: string | null }) {
  const t = useTranslations("Mcp");
  const access = accessOf(server);
  const connected = companyConnected(server, companyId);
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-sm break-words text-foreground">
        {t("list.access", {
          global: String(server.global),
          allowed: access.allowed,
          first: access.first,
          more: Math.max(access.allowed - 1, 0),
        })}
      </p>
      {access.blocks ? <p className="text-xs text-muted">{t("list.blocks", { count: access.blocks })}</p> : null}
      {server.template && companyId ? (
        <Chip size="sm" variant="soft" color={connected ? "success" : "warning"}>
          {connected ? t("install.connected") : t("install.missing")}
        </Chip>
      ) : null}
      {server.template && !companyId ? (
        <p className="text-xs text-muted">{t("install.companies", { count: server.installations.length })}</p>
      ) : null}
    </div>
  );
}
