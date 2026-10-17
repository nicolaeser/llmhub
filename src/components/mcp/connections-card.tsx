"use client";

import { useEffect, useState } from "react";
import { Button, Card, Chip, Skeleton, useOverlayState } from "@heroui/react";
import { Blocks, Link2, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import InstallDialog from "@/components/mcp/install-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import type { McpCompanyServers, McpServerView } from "@/types/mcp";

type ConnectionState = "connected" | "paused" | "missing";

function connectionOf(server: McpServerView, orgId: string): ConnectionState {
  const row = server.installations.find((item) => item.orgId === orgId);
  if (!row) return "missing";
  if (!row.enabled) return "paused";
  return row.authType === "none" || row.hasSecret ? "connected" : "missing";
}

function stateColor(state: ConnectionState): "success" | "warning" | "default" {
  if (state === "connected") return "success";
  if (state === "missing") return "warning";
  return "default";
}

export default function McpConnectionsCard({
  orgId,
  load,
  onInstall,
}: {
  orgId: string;
  load: (orgId: string) => Promise<McpCompanyServers | ActionFail>;
  onInstall: Parameters<typeof InstallDialog>[0]["onInstall"];
}) {
  const t = useTranslations("Mcp.connections");
  const tMcp = useTranslations("Mcp");
  const showError = useErrorToast();
  const [data, setData] = useState<McpCompanyServers | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const dialog = useOverlayState();

  useEffect(() => {
    let active = true;
    load(orgId).then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        if (result.error !== "FORBIDDEN" && result.error !== "Forbidden") showError(result.error);
        setFailed(true);
        return;
      }
      setData(result);
    });
    return () => {
      active = false;
    };
  }, [orgId, load, showError]);

  if (failed) return null;

  function open(server: McpServerView) {
    setEditing(server);
    setDialogKey((n) => n + 1);
    dialog.open();
  }

  function replace(server: McpServerView) {
    setData((current) =>
      current ? { ...current, servers: current.servers.map((row) => (row.id === server.id ? server : row)) } : current,
    );
  }

  const connected = data ? data.servers.filter((server) => connectionOf(server, orgId) === "connected").length : 0;

  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <IconTile icon={Blocks} size="sm" />
          <div className="min-w-0 space-y-1">
            <Card.Title>{t("title")}</Card.Title>
            <Card.Description>{t("description")}</Card.Description>
          </div>
        </div>
        {data && data.servers.length ? (
          <Chip size="sm" variant="soft" color={connected === data.servers.length ? "success" : "warning"}>
            {t("summary", { count: connected, total: data.servers.length })}
          </Chip>
        ) : null}
      </Card.Header>
      <Card.Content>
        {!data ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </div>
        ) : data.servers.length === 0 ? (
          <p className="text-sm text-muted">{t("empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.servers.map((server) => {
              const state = connectionOf(server, orgId);
              const row = server.installations.find((item) => item.orgId === orgId);
              const authType = row?.authType ?? (server.authType === "header" || server.authType === "none" ? server.authType : "bearer");
              return (
                <li key={server.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium break-all text-foreground">{server.name}</span>
                      {server.kind === "hosted" ? (
                        <Chip size="sm" variant="soft">
                          {tMcp("hosted")}
                        </Chip>
                      ) : null}
                      <Chip size="sm" variant="soft" color={stateColor(state)}>
                        {t("state", { state })}
                      </Chip>
                    </div>
                    <p className="text-xs text-muted">
                      {t("auth", { type: authType, header: row?.authHeader || server.authHeader || "" })}
                      {" · "}
                      {t("tools", { count: server.tools.length })}
                    </p>
                    {server.description ? <p className="text-sm text-muted">{server.description}</p> : null}
                  </div>
                  {data.canInstall ? (
                    <Button size="sm" variant={state === "connected" ? "tertiary" : "secondary"} onPress={() => open(server)}>
                      {state === "connected" ? <Pencil size={14} aria-hidden /> : <Link2 size={14} aria-hidden />}
                      {t("action", { state })}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Card.Content>
      {data ? (
        <InstallDialog
          key={`connection-${dialogKey}`}
          state={dialog}
          server={editing}
          companies={[data.company]}
          companyId={orgId}
          canManage={false}
          onInstall={onInstall}
          onSaved={replace}
        />
      ) : null}
    </Card>
  );
}
