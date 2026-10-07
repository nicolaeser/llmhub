"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import {
  Alert,
  Button,
  Chip,
  Dropdown,
  SearchField,
  Spinner,
  Table,
  toast,
  useOverlayState,
} from "@heroui/react";
import { MoreHorizontal, Plus, User } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import BudgetDialog from "@/components/budget/budget-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { isActionFail } from "@/lib/http/action-result";
import type { ActionFail } from "@/types/actions";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { useRoleName } from "@/components/security/use-role-name";
import { useSecurityError } from "@/components/security/use-security-error";
import type { BudgetResult, BudgetView } from "@/types/structure";
import type { ConsoleUser, UsersConsolePayload } from "@/types/users";
import { setBudgetAction } from "@/app/(app)/companies/_action";
import {
  ChangeAccessDialog,
  CreateUserDialog,
  DeleteUserDialog,
  SetPasswordDialog,
} from "./_components/user-dialogs";
import {
  loadConsoleUsersAction,
  resetUserTwoFactorAction,
  revokeUserSessionsAction,
  setUserBlockedAction,
  setUserContentLoggingAction,
} from "./_action";

function userBudget(user: ConsoleUser): BudgetView {
  return {
    maxBudget: user.maxBudget,
    spend: user.spend,
    budgetDuration: user.budgetDuration,
    boost: 0,
    boosts: [],
    resetsAt: null,
    projectedMonth: 0,
    daysToExhaust: null,
    pctUsed: null,
  };
}

export default function UsersPage() {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 30_000 });
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const [data, setData] = useState<UsersConsolePayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ConsoleUser | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const createState = useOverlayState();
  const passwordState = useOverlayState();
  const roleState = useOverlayState();
  const budgetState = useOverlayState();
  const deleteState = useOverlayState();
  const resetState = useOverlayState();

  useEffect(() => {
    loadConsoleUsersAction().then((result) => {
      if (isActionFail(result)) {
        setLoadError(result.error);
        return;
      }
      setData(result);
    });
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return (data?.users ?? []).filter(
      (user) =>
        !q || user.username.toLowerCase().includes(q) || user.email.toLowerCase().includes(q),
    );
  }, [query, data]);

  function openDialog(state: ReturnType<typeof useOverlayState>, user: ConsoleUser | null) {
    setTarget(user);
    setDialogKey((n) => n + 1);
    state.open();
  }

  function runRowAction(
    id: string,
    action: () => Promise<UsersConsolePayload | ActionFail>,
    success: string,
  ) {
    setBusyId(id);
    start(async () => {
      const result = await action();
      setBusyId(null);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      setData(result);
      toast(success, { variant: "success" });
    });
  }

  function applyBudget(result: BudgetResult) {
    setData((current) =>
      current
        ? {
            ...current,
            users: current.users.map((user) =>
              user.id === result.id
                ? {
                    ...user,
                    maxBudget: result.budget.maxBudget,
                    spend: result.budget.spend,
                    budgetDuration: result.budget.budgetDuration,
                  }
                : user,
            ),
          }
        : current,
    );
  }

  if (loadError) {
    return (
      <div>
        <PageHeader title={t("title")} subtitle={t("subtitle")} />
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{errorText(loadError)}</Alert.Description>
          </Alert.Content>
        </Alert>
      </div>
    );
  }

  if (!data) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const createButton = data.canManage ? (
    <Button onPress={() => openDialog(createState, null)}>
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  ) : undefined;

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={data.users.length ? createButton : undefined}
      />
      {data.users.length === 0 ? (
        <EmptyState icon={User} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <>
          <SearchField
            value={query}
            onChange={setQuery}
            aria-label={t("searchPlaceholder")}
            className="mb-4 max-w-sm"
          >
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("searchPlaceholder")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
          {filtered.length === 0 ? (
            <EmptyState icon={User} title={t("noMatches")} />
          ) : (
            <Table aria-label={t("title")}>
              <Table.ScrollContainer>
                <Table.Content>
                  <Table.Header>
                    <Table.Column isRowHeader>{t("columns.user")}</Table.Column>
                    <Table.Column>{t("columns.role")}</Table.Column>
                    <Table.Column>{t("columns.access")}</Table.Column>
                    <Table.Column>{t("columns.security")}</Table.Column>
                    <Table.Column>{tCommon("status")}</Table.Column>
                    <Table.Column>{t("columns.lastActive")}</Table.Column>
                    <Table.Column>{tCommon("actions")}</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {filtered.map((user) => (
                      <Table.Row key={user.id} id={user.id}>
                        <Table.Cell>
                          <div className="min-w-0">
                            <p className="text-sm font-medium">{user.username}</p>
                            <p className="text-xs text-muted">{user.email}</p>
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {user.isOwner
                            ? t("ownerRole")
                            : roleName(
                                user.roleId
                                  ? { name: user.roleName, templateKey: user.roleTemplateKey }
                                  : null,
                              )}
                        </Table.Cell>
                        <Table.Cell>
                          <p className="text-sm">
                            {t("access", { scope: user.orgId ? "company" : "platform", org: user.orgAlias })}
                          </p>
                          <p className="text-xs text-muted">
                            {tCommon("spendBudget", {
                              hasCap: user.maxBudget > 0 ? "yes" : "no",
                              spend: user.spend,
                              budget: user.maxBudget,
                            })}
                          </p>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">
                            <Chip size="sm" variant="soft" color={user.twoFactorEnabled ? "success" : "warning"}>
                              {t("twoFactor", { enabled: user.twoFactorEnabled ? "true" : "false" })}
                            </Chip>
                            {user.passkeys ? (
                              <Chip size="sm" variant="soft">
                                {t("passkeys", { count: user.passkeys })}
                              </Chip>
                            ) : null}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">
                            {user.isOwner ? (
                              <Chip size="sm" variant="soft" color="accent">
                                {t("owner")}
                              </Chip>
                            ) : null}
                            <Chip size="sm" variant="soft" color={user.blocked ? "danger" : "default"}>
                              {tCommon("blockedState", { blocked: user.blocked ? "true" : "false" })}
                            </Chip>
                            {user.mustChangePassword ? (
                              <Chip size="sm" variant="soft" color="warning">
                                {t("mustChangePassword")}
                              </Chip>
                            ) : null}
                            {user.logContent ? null : (
                              <Chip size="sm" variant="soft" color="warning">
                                {t("contentOff")}
                              </Chip>
                            )}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          {user.lastActive
                            ? format.relativeTime(new Date(user.lastActive), now)
                            : tCommon("none")}
                        </Table.Cell>
                        <Table.Cell>
                          {user.manageable && (data.canManage || data.canSecure || data.canBudget) ? (
                            <Dropdown>
                              <Dropdown.Trigger>
                                <Button
                                  isIconOnly
                                  size="sm"
                                  variant="ghost"
                                  isPending={busyId === user.id}
                                  aria-label={t("actionsMenu", { username: user.username })}
                                >
                                  {({ isPending }) =>
                                    isPending ? (
                                      <Spinner color="current" size="sm" />
                                    ) : (
                                      <MoreHorizontal size={14} aria-hidden />
                                    )
                                  }
                                </Button>
                              </Dropdown.Trigger>
                              <Dropdown.Popover>
                                <Dropdown.Menu
                                  aria-label={t("actionsMenu", { username: user.username })}
                                  onAction={(key) => {
                                    if (key === "role") openDialog(roleState, user);
                                    if (key === "budget") openDialog(budgetState, user);
                                    if (key === "password") openDialog(passwordState, user);
                                    if (key === "delete") openDialog(deleteState, user);
                                    if (key === "reset") openDialog(resetState, user);
                                    if (key === "block") {
                                      runRowAction(
                                        user.id,
                                        () => setUserBlockedAction(user.id, !user.blocked),
                                        t("toasts.blocked", { blocked: !user.blocked ? "true" : "false" }),
                                      );
                                    }
                                    if (key === "content") {
                                      runRowAction(
                                        user.id,
                                        () => setUserContentLoggingAction(user.id, !user.logContent),
                                        t("toasts.contentLogging", { enabled: !user.logContent ? "true" : "false" }),
                                      );
                                    }
                                    if (key === "sessions") {
                                      runRowAction(
                                        user.id,
                                        () => revokeUserSessionsAction(user.id),
                                        t("toasts.sessionsRevoked"),
                                      );
                                    }
                                  }}
                                >
                                  {data.canManage ? (
                                    <Dropdown.Item id="role" textValue={t("changeRole")}>
                                      {t("changeRole")}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canBudget ? (
                                    <Dropdown.Item id="budget" textValue={t("budget")}>
                                      {t("budget")}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canManage ? (
                                    <Dropdown.Item id="password" textValue={t("setPassword")}>
                                      {t("setPassword")}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canManage ? (
                                    <Dropdown.Item
                                      id="content"
                                      textValue={t("contentAction", { enabled: user.logContent ? "true" : "false" })}
                                    >
                                      {t("contentAction", { enabled: user.logContent ? "true" : "false" })}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canSecure ? (
                                    <Dropdown.Item id="sessions" textValue={t("revokeSessions")}>
                                      {t("revokeSessions")}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canSecure ? (
                                    <Dropdown.Item id="reset" textValue={t("resetTwoFactor")}>
                                      {t("resetTwoFactor")}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canManage ? (
                                    <Dropdown.Item
                                      id="block"
                                      textValue={t("blockAction", { blocked: user.blocked ? "true" : "false" })}
                                    >
                                      {t("blockAction", { blocked: user.blocked ? "true" : "false" })}
                                    </Dropdown.Item>
                                  ) : null}
                                  {data.canManage ? (
                                    <Dropdown.Item id="delete" textValue={tCommon("delete")}>
                                      {tCommon("delete")}
                                    </Dropdown.Item>
                                  ) : null}
                                </Dropdown.Menu>
                              </Dropdown.Popover>
                            </Dropdown>
                          ) : null}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
            </Table>
          )}
        </>
      )}

      <CreateUserDialog
        key={`create-${dialogKey}`}
        state={createState}
        roles={data.roles}
        orgs={data.orgs}
        onSaved={setData}
      />
      <ChangeAccessDialog
        key={`role-${dialogKey}`}
        state={roleState}
        target={target}
        roles={data.roles}
        orgs={data.orgs}
        onSaved={setData}
      />
      <BudgetDialog
        key={`budget-${dialogKey}`}
        state={budgetState}
        target={target ? { kind: "user", id: target.id, alias: target.username } : null}
        budget={target ? userBudget(target) : null}
        ancestors={[]}
        onSubmit={setBudgetAction}
        onSaved={applyBudget}
      />
      <SetPasswordDialog
        key={`password-${dialogKey}`}
        state={passwordState}
        target={target}
        onSaved={setData}
      />
      <DeleteUserDialog
        key={`delete-${dialogKey}`}
        state={deleteState}
        target={target}
        onDeleted={(id) =>
          setData((current) =>
            current ? { ...current, users: current.users.filter((user) => user.id !== id) } : current,
          )
        }
      />
      <StepUpDialog
        state={resetState}
        title={t("resetTwoFactor")}
        description={t("resetTwoFactorHint", { username: target?.username ?? "" })}
        confirmLabel={t("resetTwoFactor")}
        danger
        onConfirm={async (code) => {
          if (!target) return null;
          const result = await resetUserTwoFactorAction({ userId: target.id, code });
          if (isActionFail(result)) return result.error;
          setData(result);
          toast(t("toasts.twoFactorReset"), { variant: "success" });
          return null;
        }}
      />
    </div>
  );
}
