"use client";

import { useTransition } from "react";
import { Button, Dropdown, Spinner, toast, useOverlayState } from "@heroui/react";
import {
  KeyRound,
  LogIn,
  LogOut,
  MoreHorizontal,
  Pencil,
  Power,
  RefreshCw,
  Shield,
  Trash2,
  Users,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { McpServerView } from "@/types/mcp";
import {
  deleteMcpServerAction,
  disconnectMcpOAuthAction,
  refreshMcpServerAction,
  setMcpServerEnabledAction,
  startMcpOAuthAction,
} from "../_action";
import { companyConnected } from "./server-view";

export type ServerFlags = {
  canManage: boolean;
  canInstall: boolean;
  canAssign: boolean;
  companyId: string | null;
};

export type ServerHandlers = {
  onEdit: (server: McpServerView) => void;
  onAccess: (server: McpServerView) => void;
  onPermissions: (server: McpServerView) => void;
  onInstall: (server: McpServerView) => void;
  onChanged: (server: McpServerView) => void;
  onDeleted: (id: string) => void;
};

type MenuAction = "edit" | "access" | "permissions" | "install" | "reload" | "signin" | "signout" | "toggle" | "delete";

const ICONS: Record<MenuAction, LucideIcon> = {
  edit: Pencil,
  access: Users,
  permissions: Shield,
  install: KeyRound,
  reload: RefreshCw,
  signin: LogIn,
  signout: LogOut,
  toggle: Power,
  delete: Trash2,
};

export default function ServerActions({
  server,
  flags,
  handlers,
}: {
  server: McpServerView;
  flags: ServerFlags;
  handlers: ServerHandlers;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [busy, start] = useTransition();
  const [signingIn, startSignIn] = useTransition();
  const deleteState = useOverlayState();
  const signOutState = useOverlayState();
  const { canManage, canInstall, canAssign, companyId } = flags;
  const browserSignIn = server.authType === "oauth" && server.oauthGrant === "authorization_code";
  const signedIn = server.oauth?.status === "active";
  const canConnect = canInstall && (server.template || canManage);
  const needsSignIn = canManage && browserSignIn && !signedIn;
  const needsKey = Boolean(canConnect && companyId && server.template && !companyConnected(server, companyId));

  const actions: MenuAction[] = [
    ...(canManage ? (["edit"] as const) : []),
    ...(canAssign ? (["access"] as const) : []),
    ...(canManage ? (["permissions"] as const) : []),
    ...(canConnect && !needsKey ? (["install"] as const) : []),
    ...(canManage && server.kind !== "hosted" && server.enabled ? (["reload"] as const) : []),
    ...(canManage && browserSignIn && signedIn ? (["signin", "signout"] as const) : []),
    ...(canManage ? (["toggle", "delete"] as const) : []),
  ];

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

  function toggle() {
    start(async () => {
      const result = await setMcpServerEnabledAction({ id: server.id, enabled: !server.enabled });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      handlers.onChanged(result.server);
      toast(t("list.toggled", { enabled: String(result.server.enabled) }), { variant: "success" });
    });
  }

  function reload() {
    start(async () => {
      const result = await refreshMcpServerAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      handlers.onChanged(result.server);
      if (result.server.lastError) toast.danger(t("errors.code", { code: result.server.lastError }));
      else toast(t("card.reloaded", { count: result.server.tools.length }), { variant: "success" });
    });
  }

  function signOut() {
    start(async () => {
      const result = await disconnectMcpOAuthAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      handlers.onChanged(result.server);
      toast(t("oauth.signedOut"), { variant: "success" });
    });
  }

  function remove() {
    start(async () => {
      const result = await deleteMcpServerAction(server.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      handlers.onDeleted(result.id);
      toast(t("form.deleted"), { variant: "success" });
    });
  }

  function choose(action: MenuAction) {
    if (action === "edit") handlers.onEdit(server);
    else if (action === "access") handlers.onAccess(server);
    else if (action === "permissions") handlers.onPermissions(server);
    else if (action === "install") handlers.onInstall(server);
    else if (action === "reload") reload();
    else if (action === "signin") signIn();
    else if (action === "signout") signOutState.open();
    else if (action === "toggle") toggle();
    else deleteState.open();
  }

  function label(action: MenuAction): string {
    return t("list.menuItem", {
      action: action === "toggle" ? (server.enabled ? "disable" : "enable") : action,
      company: String(Boolean(companyId)),
    });
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {needsSignIn ? (
        <Button size="sm" variant="secondary" isPending={signingIn} isDisabled={!server.enabled} onPress={signIn}>
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : <LogIn size={14} aria-hidden />}
              {t("oauth.signIn", { again: "false" })}
            </>
          )}
        </Button>
      ) : null}
      {needsKey ? (
        <Button size="sm" variant="secondary" onPress={() => handlers.onInstall(server)}>
          <KeyRound size={14} aria-hidden />
          {t("list.connectKey")}
        </Button>
      ) : null}
      {actions.length ? (
        <Dropdown>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            isPending={busy}
            aria-label={t("list.menu", { name: server.name })}
          >
            {({ isPending }) =>
              isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />
            }
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={t("list.menu", { name: server.name })}
              onAction={(key) => {
                const action = actions.find((item) => item === key);
                if (action) choose(action);
              }}
            >
              {actions.map((action) => {
                const Icon = ICONS[action];
                return (
                  <Dropdown.Item
                    key={action}
                    id={action}
                    textValue={label(action)}
                    variant={action === "delete" ? "danger" : "default"}
                  >
                    <Icon size={14} aria-hidden />
                    {label(action)}
                  </Dropdown.Item>
                );
              })}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : null}
      {canManage ? (
        <>
          <ConfirmDialog
            state={deleteState}
            title={t("card.deleteTitle", { name: server.name })}
            description={t("card.deleteConfirm")}
            confirmLabel={tCommon("delete")}
            cancelLabel={tCommon("cancel")}
            pending={busy}
            onConfirm={remove}
          />
          <ConfirmDialog
            state={signOutState}
            status="warning"
            title={t("oauth.signOut")}
            description={t("oauth.signOutConfirm", { name: server.name })}
            confirmLabel={t("oauth.signOut")}
            cancelLabel={tCommon("cancel")}
            pending={busy}
            onConfirm={signOut}
          />
        </>
      ) : null}
    </div>
  );
}
