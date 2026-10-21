"use client";

import { useState } from "react";
import { Alert, Button, CloseButton, useOverlayState } from "@heroui/react";
import { AlertTriangle, Blocks, CheckCircle2, Plus, Sparkles, Wrench } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import StatCard from "@/components/console/stat-card";
import InstallDialog from "@/components/mcp/install-dialog";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import type { McpServerView } from "@/types/mcp";
import { loadMcpServersAction, saveMcpInstallationAction, setMcpTemplateAction } from "./_action";
import AccessDialog from "./_components/access-dialog";
import BuilderDialog from "./_components/builder-dialog";
import PermissionsDialog from "./_components/permissions-dialog";
import ServerCard from "./_components/server-card";
import ServerDialog from "./_components/server-dialog";

function McpServerGrid({
  rows,
  emptyTitle,
  empty,
  canManage,
  canInstall,
  canAssign,
  companyId,
  onEdit,
  onAccess,
  onPermissions,
  onInstall,
  onChanged,
  onDeleted,
}: {
  rows: McpServerView[];
  emptyTitle: string;
  empty: string;
  canManage: boolean;
  canInstall: boolean;
  canAssign: boolean;
  companyId: string | null;
  onEdit: (server: McpServerView | null) => void;
  onAccess: (server: McpServerView) => void;
  onPermissions: (server: McpServerView) => void;
  onInstall: (server: McpServerView) => void;
  onChanged: (server: McpServerView) => void;
  onDeleted: (id: string) => void;
}) {
  if (rows.length === 0) {
    return <EmptyState icon={Blocks} title={emptyTitle} description={empty} />;
  }
  return (
    <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
      {rows.map((server) => (
        <ServerCard
          key={server.id}
          server={server}
          canManage={canManage}
          canInstall={canInstall}
          canAssign={canAssign}
          companyId={companyId}
          onEdit={onEdit}
          onAccess={onAccess}
          onPermissions={onPermissions}
          onInstall={onInstall}
          onChanged={onChanged}
          onDeleted={onDeleted}
        />
      ))}
    </div>
  );
}

export default function McpPage() {
  const t = useTranslations("Mcp");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const oauthResult = useSearchParam("oauth");
  const oauthReason = useSearchParam("reason") ?? "";
  const oauthServer = useSearchParam("server") ?? "";
  const page = useActionData(loadMcpServersAction);
  const { data, setData } = page;
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [access, setAccess] = useState<McpServerView | null>(null);
  const [permissions, setPermissions] = useState<McpServerView | null>(null);
  const [install, setInstall] = useState<McpServerView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const formState = useOverlayState();
  const accessState = useOverlayState();
  const permissionsState = useOverlayState();
  const installState = useOverlayState();
  const builderState = useOverlayState();

  if (!data) {
    return <PageStatus icon={Blocks} title={t("title")} subtitle={t("subtitle")} state={page} stats={4} layout="cards" />;
  }

  const { servers, canManage, canInstall, canAssign, companyId, companies, redirectUri } = data;
  const connectedName = servers.find((row) => row.id === oauthServer)?.name ?? "";
  const dismissOAuth = () => setSearchParams({ oauth: null, reason: null, server: null });

  function replace(server: McpServerView) {
    setData((current) => ({
      ...current,
      servers: current.servers.some((row) => row.id === server.id)
        ? current.servers.map((row) => (row.id === server.id ? server : row))
        : [...current.servers, server].sort((a, b) => a.name.localeCompare(b.name)),
    }));
    setAccess((current) => (current?.id === server.id ? server : current));
    setPermissions((current) => (current?.id === server.id ? server : current));
    setInstall((current) => (current?.id === server.id ? server : current));
  }

  function openForm(server: McpServerView | null) {
    setEditing(server);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function openAccess(server: McpServerView) {
    setAccess(server);
    setDialogKey((n) => n + 1);
    accessState.open();
  }

  function openPermissions(server: McpServerView) {
    setPermissions(server);
    setDialogKey((n) => n + 1);
    permissionsState.open();
  }

  function openInstall(server: McpServerView) {
    setInstall(server);
    setDialogKey((n) => n + 1);
    installState.open();
  }

  const connectedRows = servers.filter((row) => row.status === "connected");
  const connected = connectedRows.length;
  const failing = servers.filter((row) => row.status === "error").length;
  const attentionRows = servers.filter((row) => row.status === "error" || row.status === "signin");
  const disabledRows = servers.filter((row) => !row.enabled);
  const gridProps = {
    emptyTitle: t("emptyFilter"),
    canManage,
    canInstall,
    canAssign,
    companyId,
    onEdit: openForm,
    onAccess: openAccess,
    onPermissions: openPermissions,
    onInstall: openInstall,
    onChanged: replace,
    onDeleted: (id: string) => setData((current) => ({ ...current, servers: current.servers.filter((row) => row.id !== id) })),
  };
  const tools = servers
    .filter((row) => row.enabled)
    .reduce(
      (sum, row) =>
        sum + (row.toolsRestricted ? row.tools.filter((tool) => row.allowedTools.includes(tool.name)).length : row.tools.length),
      0,
    );
  const actions = canManage ? (
    <>
      <Button
        variant="secondary"
        onPress={() => {
          setDialogKey((n) => n + 1);
          builderState.open();
        }}
      >
        <Sparkles size={14} aria-hidden />
        {t("builder.open")}
      </Button>
      <Button onPress={() => openForm(null)}>
        <Plus size={14} aria-hidden />
        {t("add")}
      </Button>
    </>
  ) : null;

  return (
    <div className="space-y-5">
      <PageHeader icon={Blocks} title={t("title")} subtitle={t("subtitle")} actions={actions ?? undefined} />
      <LoadError state={page} />
      {oauthResult === "connected" || oauthResult === "failed" ? (
        <Alert status={oauthResult === "connected" ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("oauth.result", { result: oauthResult, named: String(Boolean(connectedName)), name: connectedName })}</Alert.Title>
            {oauthResult === "failed" ? <Alert.Description>{tError("code", { code: oauthReason })}</Alert.Description> : null}
          </Alert.Content>
          <CloseButton aria-label={t("oauth.dismiss")} onPress={dismissOAuth} />
        </Alert>
      ) : null}
      {canManage ? null : (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{canInstall ? t("installOnly") : t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {servers.length === 0 ? (
        <EmptyState icon={Blocks} title={t("empty.title")} description={t("empty.description")} action={actions ?? undefined} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 xl:grid-cols-4">
            <StatCard label={t("stats.servers")} value={format.number(servers.length)} icon={Blocks} tone="accent" />
            <StatCard label={t("stats.connected")} value={format.number(connected)} icon={CheckCircle2} tone="success" />
            <StatCard label={t("stats.tools")} value={format.number(tools)} icon={Wrench} tone="accent" />
            <StatCard
              label={t("stats.errors")}
              value={format.number(failing)}
              icon={AlertTriangle}
              tone={failing ? "danger" : "neutral"}
            />
          </div>
          <PageTabs
            label={t("title")}
            tabs={[
              {
                id: "all",
                label: `${t("tabs", { tab: "all" })} (${format.number(servers.length)})`,
                panel: <McpServerGrid rows={servers} empty={t("empty.description")} {...gridProps} />,
              },
              {
                id: "connected",
                label: `${t("tabs", { tab: "connected" })} (${format.number(connectedRows.length)})`,
                panel: <McpServerGrid rows={connectedRows} empty={t("emptyFilter")} {...gridProps} />,
              },
              {
                id: "attention",
                label: `${t("tabs", { tab: "attention" })} (${format.number(attentionRows.length)})`,
                panel: <McpServerGrid rows={attentionRows} empty={t("emptyFilter")} {...gridProps} />,
              },
              {
                id: "disabled",
                label: `${t("tabs", { tab: "disabled" })} (${format.number(disabledRows.length)})`,
                panel: <McpServerGrid rows={disabledRows} empty={t("emptyFilter")} {...gridProps} />,
              },
            ]}
          />
        </>
      )}
      {canManage ? (
        <>
          <ServerDialog
            key={`form-${dialogKey}`}
            state={formState}
            editing={editing}
            redirectUri={redirectUri}
            onSaved={replace}
          />
          <PermissionsDialog key={`permissions-${dialogKey}`} state={permissionsState} server={permissions} onSaved={replace} />
          <BuilderDialog
            key={`builder-${dialogKey}`}
            state={builderState}
            model={data.builderModel}
            models={data.models}
            onModel={(builderModel) => setData((current) => ({ ...current, builderModel }))}
            onCreated={replace}
          />
        </>
      ) : null}
      {canAssign ? (
        <AccessDialog
          key={`access-${dialogKey}`}
          state={accessState}
          server={access}
          platform={!companyId}
          onSaved={replace}
        />
      ) : null}
      {canInstall ? (
        <InstallDialog
          key={`install-${dialogKey}`}
          state={installState}
          server={install}
          companies={companies}
          companyId={companyId}
          canManage={canManage}
          onInstall={saveMcpInstallationAction}
          onTemplate={setMcpTemplateAction}
          onSaved={replace}
        />
      ) : null}
    </div>
  );
}
