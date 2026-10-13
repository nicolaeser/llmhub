"use client";

import { useState } from "react";
import { Alert, Button, useOverlayState } from "@heroui/react";
import { AlertTriangle, Blocks, CheckCircle2, Plus, Wrench } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import PageStatus, { LoadError } from "@/components/console/page-status";
import StatCard from "@/components/console/stat-card";
import { useActionData } from "@/lib/hooks/use-action-data";
import type { McpServerView } from "@/types/mcp";
import { loadMcpServersAction } from "./_action";
import AccessDialog from "./_components/access-dialog";
import ServerCard from "./_components/server-card";
import ServerDialog from "./_components/server-dialog";

export default function McpPage() {
  const t = useTranslations("Mcp");
  const format = useFormatter();
  const page = useActionData(loadMcpServersAction);
  const { data, setData } = page;
  const [editing, setEditing] = useState<McpServerView | null>(null);
  const [access, setAccess] = useState<McpServerView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const formState = useOverlayState();
  const accessState = useOverlayState();

  if (!data) {
    return <PageStatus title={t("title")} subtitle={t("subtitle")} state={page} />;
  }

  const { servers, canManage } = data;

  function replace(server: McpServerView) {
    setData((current) => ({
      ...current,
      servers: current.servers.some((row) => row.id === server.id)
        ? current.servers.map((row) => (row.id === server.id ? server : row))
        : [...current.servers, server].sort((a, b) => a.name.localeCompare(b.name)),
    }));
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

  const connected = servers.filter((row) => row.status === "connected").length;
  const failing = servers.filter((row) => row.status === "error").length;
  const tools = servers
    .filter((row) => row.enabled)
    .reduce(
      (sum, row) =>
        sum + (row.toolsRestricted ? row.tools.filter((tool) => row.allowedTools.includes(tool.name)).length : row.tools.length),
      0,
    );
  const addButton = canManage ? (
    <Button onPress={() => openForm(null)}>
      <Plus size={14} aria-hidden />
      {t("add")}
    </Button>
  ) : null;

  return (
    <div className="space-y-5">
      <PageHeader icon={Blocks} title={t("title")} subtitle={t("subtitle")} actions={servers.length ? addButton : undefined} />
      <LoadError state={page} />
      {canManage ? null : (
        <Alert status="accent">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("readOnly")}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {servers.length === 0 ? (
        <EmptyState icon={Blocks} title={t("empty.title")} description={t("empty.description")} action={addButton} />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
          <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3">
            {servers.map((server) => (
              <ServerCard
                key={server.id}
                server={server}
                canManage={canManage}
                onEdit={openForm}
                onAccess={openAccess}
                onChanged={replace}
                onDeleted={(id) => setData((current) => ({ ...current, servers: current.servers.filter((row) => row.id !== id) }))}
              />
            ))}
          </div>
        </>
      )}
      <ServerDialog key={`form-${dialogKey}`} state={formState} editing={editing} onSaved={replace} />
      <AccessDialog key={`access-${dialogKey}`} state={accessState} server={access} onSaved={replace} />
    </div>
  );
}
