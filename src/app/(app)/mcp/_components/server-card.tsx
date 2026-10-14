"use client";

import { useTransition } from "react";
import { Button, Card, Chip, Label, Spinner, Switch, toast } from "@heroui/react";
import { LogIn, LogOut, Pencil, RefreshCw, Trash2, Users } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpServerStatus, McpServerView } from "@/types/mcp";
import {
  deleteMcpServerAction,
  disconnectMcpOAuthAction,
  refreshMcpServerAction,
  setMcpServerEnabledAction,
  startMcpOAuthAction,
} from "../_action";

const STATUS_COLOR = {
  connected: "success",
  error: "danger",
  disabled: "default",
  unchecked: "warning",
  signin: "warning",
} as const satisfies Record<McpServerStatus, "success" | "danger" | "warning" | "default">;

function enabledTools(server: McpServerView): number {
  if (!server.toolsRestricted) return server.tools.length;
  return server.tools.filter((tool) => server.allowedTools.includes(tool.name)).length;
}

export default function ServerCard({
  server,
  canManage,
  onEdit,
  onAccess,
  onChanged,
  onDeleted,
}: {
  server: McpServerView;
  canManage: boolean;
  onEdit: (server: McpServerView) => void;
  onAccess: (server: McpServerView) => void;
  onChanged: (server: McpServerView) => void;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const showError = useErrorToast();
  const [toggling, startToggle] = useTransition();
  const [refreshing, startRefresh] = useTransition();
  const [deleting, startDelete] = useTransition();
  const [signingIn, startSignIn] = useTransition();
  const [signingOut, startSignOut] = useTransition();
  const allowed = enabledTools(server);
  const browserSignIn = server.authType === "oauth" && server.oauthGrant === "authorization_code";
  const signedIn = server.oauth?.status === "active";

  function toggle(enabled: boolean) {
    startToggle(async () => {
      const result = await setMcpServerEnabledAction({ id: server.id, enabled });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChanged(result.server);
    });
  }

  function refresh() {
    startRefresh(async () => {
      const result = await refreshMcpServerAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChanged(result.server);
      if (result.server.lastError) toast.danger(t("errors.code", { code: result.server.lastError }));
      else toast(t("card.reloaded", { count: result.server.tools.length }), { variant: "success" });
    });
  }

  function signIn() {
    startSignIn(async () => {
      const result = await startMcpOAuthAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      window.location.assign(result.url);
    });
  }

  function signOut() {
    startSignOut(async () => {
      const result = await disconnectMcpOAuthAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChanged(result.server);
      toast(t("oauth.signedOut"), { variant: "success" });
    });
  }

  function remove() {
    startDelete(async () => {
      const result = await deleteMcpServerAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onDeleted(result.id);
      toast(t("form.deleted"), { variant: "success" });
    });
  }

  return (
    <Card>
      <Card.Header>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title className="truncate">{server.name}</Card.Title>
            <Card.Description className="truncate font-mono text-xs">{server.url}</Card.Description>
          </div>
          <Chip size="sm" variant="soft" color={STATUS_COLOR[server.status]}>
            {t("status", { status: server.status })}
          </Chip>
        </div>
        {server.description ? <p className="text-sm text-muted">{server.description}</p> : null}
      </Card.Header>
      <Card.Content className="space-y-3">
        <div className="flex flex-wrap gap-1">
          <Chip size="sm" variant="soft">
            {server.toolsRestricted
              ? t("allowedCount", { allowed, count: server.tools.length })
              : t("toolCount", { count: server.tools.length })}
          </Chip>
          <Chip size="sm" variant="soft">
            {t("card.auth", { type: server.authType })}
          </Chip>
          {server.era ? (
            <Chip size="sm" variant="soft">
              {t("card.protocol", { era: server.era, version: server.protocolVersion })}
            </Chip>
          ) : null}
          {server.internal ? (
            <Chip size="sm" variant="soft" color="warning">
              {t("internal")}
            </Chip>
          ) : null}
        </div>
        {server.lastError && server.status !== "signin" ? (
          <p className="text-sm text-danger">{t("errors.code", { code: server.lastError })}</p>
        ) : null}
        {server.authType === "oauth" ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 space-y-1 text-sm">
              <p className={signedIn ? "text-foreground" : "text-warning"}>
                {t("oauth.state", {
                  grant: server.oauthGrant,
                  state: signedIn ? "active" : (server.oauth?.status ?? "none"),
                  when: server.oauth ? format.relativeTime(new Date(server.oauth.connectedAt), now) : "",
                })}
              </p>
              {signedIn && server.oauth?.scope ? (
                <p className="font-mono text-xs break-all text-muted">{server.oauth.scope}</p>
              ) : null}
            </div>
            {canManage && browserSignIn ? (
              <div className="flex flex-wrap gap-1">
                {signedIn ? (
                  <ConfirmDialog
                    title={t("oauth.signOut")}
                    description={t("oauth.signOutConfirm", { name: server.name })}
                    confirmLabel={t("oauth.signOut")}
                    cancelLabel={tCommon("cancel")}
                    pending={signingOut}
                    onConfirm={signOut}
                  >
                    <Button size="sm" variant="tertiary" isPending={signingOut}>
                      {({ isPending }) => (
                        <>
                          {isPending ? <Spinner color="current" size="sm" /> : <LogOut size={14} aria-hidden />}
                          {t("oauth.signOut")}
                        </>
                      )}
                    </Button>
                  </ConfirmDialog>
                ) : null}
                <Button
                  size="sm"
                  variant={signedIn ? "secondary" : undefined}
                  isPending={signingIn}
                  isDisabled={!server.enabled}
                  onPress={signIn}
                >
                  {({ isPending }) => (
                    <>
                      {isPending ? <Spinner color="current" size="sm" /> : <LogIn size={14} aria-hidden />}
                      {t("oauth.signIn", { again: String(signedIn) })}
                    </>
                  )}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Chip size="sm" variant="soft" color={server.global || server.assignments.length ? "accent" : "default"}>
            {t("access.summary", { global: String(server.global), count: server.assignments.length })}
          </Chip>
          {canManage ? (
            <Button size="sm" variant="tertiary" aria-label={t("access.manage", { name: server.name })} onPress={() => onAccess(server)}>
              <Users size={14} aria-hidden />
              {t("access.button")}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted">
          {server.refreshedAt
            ? t("refreshed", { when: format.relativeTime(new Date(server.refreshedAt), now) })
            : t("neverRefreshed")}
        </p>
      </Card.Content>
      {canManage ? (
        <Card.Footer className="flex flex-wrap items-center justify-between gap-2">
          <Switch
            size="sm"
            isSelected={server.enabled}
            onChange={toggle}
            isDisabled={toggling}
            aria-label={t("card.enabled", { name: server.name })}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <Label>{t("card.enabledState", { enabled: String(server.enabled) })}</Label>
            </Switch.Content>
          </Switch>
          <div className="flex flex-wrap gap-1">
            <Button
              isIconOnly
              size="sm"
              variant="tertiary"
              aria-label={t("card.refresh")}
              isPending={refreshing}
              isDisabled={!server.enabled}
              onPress={refresh}
            >
              {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />)}
            </Button>
            <Button isIconOnly size="sm" variant="secondary" aria-label={t("card.edit", { name: server.name })} onPress={() => onEdit(server)}>
              <Pencil size={14} aria-hidden />
            </Button>
            <ConfirmDialog
              title={tCommon("delete")}
              description={t("card.deleteConfirm", { name: server.name })}
              confirmLabel={tCommon("delete")}
              cancelLabel={tCommon("cancel")}
              pending={deleting}
              onConfirm={remove}
            >
              <Button isIconOnly size="sm" variant="danger-soft" aria-label={tCommon("delete")} isPending={deleting}>
                <Trash2 size={14} aria-hidden />
              </Button>
            </ConfirmDialog>
          </div>
        </Card.Footer>
      ) : null}
    </Card>
  );
}
