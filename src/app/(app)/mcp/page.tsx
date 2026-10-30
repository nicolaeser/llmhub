"use client";

import { useState } from "react";
import { Alert, Button, CloseButton, useOverlayState } from "@heroui/react";
import { Blocks, Plug, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import InstallDialog from "@/components/mcp/install-dialog";
import { useActionData } from "@/lib/hooks/use-action-data";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import type { McpServerView } from "@/types/mcp";
import { loadMcpServersAction, saveMcpInstallationAction, setMcpTemplateAction } from "./_action";
import AccessDialog from "./_components/access-dialog";
import AddServerMenu, { type AddChoice } from "./_components/add-server-menu";
import BuilderDialog from "./_components/builder-dialog";
import PermissionsDialog from "./_components/permissions-dialog";
import ServerDialog from "./_components/server-dialog";
import ServerList from "./_components/server-list";

export default function McpPage() {
  const t = useTranslations("Mcp");
  const tError = useTranslations("Error");
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
    return <PageStatus icon={Blocks} title={t("title")} subtitle={t("subtitle")} state={page} filters={1} />;
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

  function openWith(state: ReturnType<typeof useOverlayState>, select: () => void) {
    select();
    setDialogKey((n) => n + 1);
    state.open();
  }

  function add(choice: AddChoice) {
    if (choice === "build") openWith(builderState, () => {});
    else openWith(formState, () => setEditing(null));
  }

  const handlers = {
    onEdit: (server: McpServerView) => openWith(formState, () => setEditing(server)),
    onAccess: (server: McpServerView) => openWith(accessState, () => setAccess(server)),
    onPermissions: (server: McpServerView) => openWith(permissionsState, () => setPermissions(server)),
    onInstall: (server: McpServerView) => openWith(installState, () => setInstall(server)),
    onChanged: replace,
    onDeleted: (id: string) =>
      setData((current) => ({ ...current, servers: current.servers.filter((row) => row.id !== id) })),
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Blocks}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={canManage && servers.length ? <AddServerMenu onChoose={add} /> : undefined}
      />
      <LoadError state={page} />
      {oauthResult === "connected" || oauthResult === "failed" ? (
        <Alert status={oauthResult === "connected" ? "success" : "danger"}>
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              {t("oauth.result", { result: oauthResult, named: String(Boolean(connectedName)), name: connectedName })}
            </Alert.Title>
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
        <EmptyState
          icon={Blocks}
          title={t("empty.title")}
          description={t("empty.description")}
          action={
            canManage ? (
              <>
                <Button variant="secondary" onPress={() => add("build")}>
                  <Sparkles size={16} aria-hidden />
                  {t("addChoice", { choice: "build" })}
                </Button>
                <Button onPress={() => add("connect")}>
                  <Plug size={16} aria-hidden />
                  {t("addChoice", { choice: "connect" })}
                </Button>
              </>
            ) : undefined
          }
        />
      ) : (
        <ServerList servers={servers} flags={{ canManage, canInstall, canAssign, companyId }} handlers={handlers} />
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
            canTestModels={data.canTestModels}
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
