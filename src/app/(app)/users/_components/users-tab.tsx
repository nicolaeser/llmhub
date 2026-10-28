"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Button,
  Chip,
  Dropdown,
  SearchField,
  Spinner,
  Table,
  Tag,
  TagGroup,
  Tooltip,
  toast,
  useOverlayState,
} from "@heroui/react";
import { MoreHorizontal, Plus, User } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { Link, useRouter } from "@/i18n/routing";
import { logsHref } from "@/lib/gateway/request-logs/request-log-query";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { usageHref } from "@/lib/usage/usage-query";
import type { ActionFail } from "@/types/actions";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { useRoleName } from "@/components/security/use-role-name";
import { useSecurityError } from "@/components/security/use-security-error";
import type { BudgetDetail, BudgetResult } from "@/types/structure";
import type { ConsoleUser, ConsoleUserBudget, UsersConsolePayload } from "@/types/users";
import {
  ChangeAccessDialog,
  CreateUserDialog,
  SetPasswordDialog,
} from "./user-dialogs";
import { hasUserActions, userActions, usersWithAccessTo, type UserAction } from "./user-actions";
import {
  addBoostAction,
  deleteUserAction,
  loadBudgetAction,
  loadConsoleUsersAction,
  removeBoostAction,
  resetUserTwoFactorAction,
  revokeUserSessionsAction,
  setUserBlockedAction,
  setBudgetAction,
  setUserContentLoggingAction,
} from "../_action";

export default function UsersTab() {
  const t = useTranslations("Users");
  const tCommon = useTranslations("Common");
  const tBudgets = useTranslations("Budgets");
  const format = useFormatter();
  const now = useClock(30_000);
  const roleName = useRoleName();
  const errorText = useSecurityError();
  const showError = useErrorToast();
  const router = useRouter();
  const company = useSearchParam("company") ?? "";
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<ConsoleUser | null>(null);
  const [budgetFor, setBudgetFor] = useState<(BudgetDetail & { alias: string }) | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, start] = useTransition();
  const createState = useOverlayState();
  const passwordState = useOverlayState();
  const roleState = useOverlayState();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const deleteState = useOverlayState();
  const resetState = useOverlayState();
  const page = useActionData(loadConsoleUsersAction);
  const { data, setData } = page;

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return usersWithAccessTo(data?.users ?? [], company).filter(
      (user) =>
        !q || user.username.toLowerCase().includes(q) || user.email.toLowerCase().includes(q),
    );
  }, [query, data, company]);

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

  function openBudget(user: ConsoleUser, state: ReturnType<typeof useOverlayState>) {
    setBusyId(user.id);
    start(async () => {
      const result = await loadBudgetAction({ kind: "user", id: user.id });
      setBusyId(null);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setBudgetFor({ ...result, alias: user.username });
      setDialogKey((n) => n + 1);
      state.open();
    });
  }

  function remove(user: ConsoleUser) {
    setBusyId(user.id);
    start(async () => {
      const result = await deleteUserAction(user.id);
      setBusyId(null);
      if (isActionFail(result)) {
        toast.danger(errorText(result.error));
        return;
      }
      setData((current) => ({ ...current, users: current.users.filter((row) => row.id !== result.id) }));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  function applyBudget(result: BudgetResult) {
    setData((current) => ({
      ...current,
      users: current.users.map((user) =>
        user.id === result.id
          ? {
              ...user,
              budget: {
                maxBudget: result.budget.maxBudget,
                spend: result.budget.spend,
                budgetDuration: result.budget.budgetDuration,
              },
            }
          : user,
      ),
    }));
    setBudgetFor((current) => (current?.id === result.id ? { ...current, budget: result.budget } : current));
  }

  if (!data) {
    return <PageStatus state={page} />;
  }

  const { canManage, canSecure, canBudget, canSeeCompanies, insights, selfId } = data;
  const showActions = hasUserActions(data);
  const companyAlias =
    data.users.find((user) => user.orgId === company)?.orgAlias ||
    data.orgs.find((org) => org.id === company)?.alias ||
    "";
  const companyLabel = t("companyFilter.value", { named: companyAlias ? "yes" : "no", alias: companyAlias });

  function roleLabel(user: ConsoleUser) {
    if (user.isOwner) return t("ownerRole");
    return roleName(user.roleId ? { name: user.roleName, templateKey: user.roleTemplateKey } : null);
  }

  function roleValue(user: ConsoleUser) {
    if (!user.managedBy) return roleLabel(user);
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <span>{roleLabel(user)}</span>
        <Tooltip delay={0} closeDelay={0}>
          <Tooltip.Trigger className="inline-flex rounded-full">
            <Chip size="sm" variant="soft" color="accent">
              {t("managed.label", { provider: user.managedBy })}
            </Chip>
          </Tooltip.Trigger>
          <Tooltip.Content className="max-w-xs">{t("managed.hint", { provider: user.managedBy })}</Tooltip.Content>
        </Tooltip>
      </span>
    );
  }

  function accessLabel(user: ConsoleUser) {
    return t("access", { scope: user.orgId ? "company" : "platform", org: user.orgAlias });
  }

  function accessValue(user: ConsoleUser) {
    if (!user.orgId || !canSeeCompanies) return accessLabel(user);
    return (
      <Link href={`/companies?node=org:${user.orgId}`} className="text-accent">
        {accessLabel(user)}
      </Link>
    );
  }

  function spendLabel(budget: ConsoleUserBudget) {
    return tCommon("spendBudget", {
      hasCap: budget.maxBudget > 0 ? "yes" : "no",
      spend: budget.spend,
      budget: budget.maxBudget,
    });
  }

  function lastActiveLabel(user: ConsoleUser) {
    return user.lastActive ? format.relativeTime(new Date(user.lastActive), now) : tCommon("none");
  }

  function securityChips(user: ConsoleUser) {
    return (
      <>
        <Chip size="sm" variant="soft" color={user.twoFactorEnabled ? "success" : "warning"}>
          {t("twoFactor", { enabled: user.twoFactorEnabled ? "true" : "false" })}
        </Chip>
        {user.passkeys ? (
          <Chip size="sm" variant="soft">
            {t("passkeys", { count: user.passkeys })}
          </Chip>
        ) : null}
      </>
    );
  }

  function statusChips(user: ConsoleUser) {
    return (
      <>
        {user.isOwner ? (
          <Chip size="sm" variant="soft" color="accent">
            {t("owner")}
          </Chip>
        ) : null}
        <Chip size="sm" variant="soft" color={user.blocked ? "danger" : "success"}>
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
      </>
    );
  }

  function actionLabel(action: UserAction, user: ConsoleUser) {
    if (action === "usage") return t("usageAction");
    if (action === "logs") return t("logsAction");
    if (action === "role") return t("changeRole");
    if (action === "budget") return t("budget");
    if (action === "boost") return tBudgets("boost.action");
    if (action === "password") return t("setPassword");
    if (action === "content") return t("contentAction", { enabled: user.logContent ? "true" : "false" });
    if (action === "sessions") return t("revokeSessions");
    if (action === "reset") return t("resetTwoFactor");
    if (action === "block") return t("blockAction", { blocked: user.blocked ? "true" : "false" });
    return tCommon("delete");
  }

  function userMenu(user: ConsoleUser) {
    const actions = userActions({ canManage, canSecure, canBudget, insights, selfId }, user);
    if (!actions.length) return null;
    return (
      <Dropdown>
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
        <Dropdown.Popover>
          <Dropdown.Menu
            aria-label={t("actionsMenu", { username: user.username })}
            onAction={(key) => {
              if (key === "usage") router.push(usageHref({ userId: user.id }));
              if (key === "logs") router.push(logsHref({ userId: user.id }));
              if (key === "role") openDialog(roleState, user);
              if (key === "budget") openBudget(user, budgetState);
              if (key === "boost") openBudget(user, boostState);
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
            {actions.map((action) => {
              const label = actionLabel(action, user);
              return (
                <Dropdown.Item key={action} id={action} textValue={label}>
                  {label}
                </Dropdown.Item>
              );
            })}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    );
  }

  const createButton = canManage ? (
    <Button onPress={() => openDialog(createState, null)}>
      <Plus size={16} aria-hidden />
      {t("create")}
    </Button>
  ) : undefined;

  return (
    <div>
      {data.users.length === 0 ? (
        <EmptyState icon={User} title={t("emptyTitle")} description={t("empty")} action={createButton} />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 grow basis-80 flex-wrap items-center gap-3">
              <SearchField
                value={query}
                onChange={setQuery}
                aria-label={t("searchPlaceholder")}
                className="w-full max-w-sm"
              >
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t("searchPlaceholder")} />
                  <SearchField.ClearButton aria-label={tCommon("close")} />
                </SearchField.Group>
              </SearchField>
              {company ? (
                <TagGroup aria-label={t("companyFilter.label")} onRemove={() => setSearchParams({ company: null })}>
                  <TagGroup.List>
                    <Tag id="company" textValue={companyLabel}>
                      <span className="break-words">{companyLabel}</span>
                      <Tag.RemoveButton aria-label={t("companyFilter.clear")} />
                    </Tag>
                  </TagGroup.List>
                </TagGroup>
              ) : null}
            </div>
            {createButton}
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              icon={User}
              title={company && !query ? t("companyFilter.empty") : t("noMatches")}
            />
          ) : (
            <>
              <RowCards label={t("title")}>
                {filtered.map((user) => (
                  <RowCard
                    key={user.id}
                    title={user.username}
                    description={user.email}
                    aside={userMenu(user)}
                    chips={
                      <>
                        {statusChips(user)}
                        {securityChips(user)}
                      </>
                    }
                    details={[
                      { label: t("columns.role"), value: roleValue(user) },
                      { label: t("columns.lastActive"), value: lastActiveLabel(user) },
                      {
                        label: t("columns.access"),
                        value: (
                          <>
                            {accessValue(user)}
                            {user.budget ? (
                              <span className="block text-xs text-muted">{spendLabel(user.budget)}</span>
                            ) : null}
                          </>
                        ),
                        wide: true,
                      },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title")} className={TABLE_FROM_LG}>
                <Table.ScrollContainer>
                  <Table.Content>
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.user")}</Table.Column>
                      <Table.Column>{t("columns.role")}</Table.Column>
                      <Table.Column>{t("columns.access")}</Table.Column>
                      <Table.Column>{t("columns.security")}</Table.Column>
                      <Table.Column>{tCommon("status")}</Table.Column>
                      <Table.Column>{t("columns.lastActive")}</Table.Column>
                      {showActions ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
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
                          <Table.Cell>{roleValue(user)}</Table.Cell>
                          <Table.Cell>
                            <p className="text-sm">{accessValue(user)}</p>
                            {user.budget ? <p className="text-xs text-muted">{spendLabel(user.budget)}</p> : null}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-1">{securityChips(user)}</div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-1">{statusChips(user)}</div>
                          </Table.Cell>
                          <Table.Cell>{lastActiveLabel(user)}</Table.Cell>
                          {showActions ? <Table.Cell>{userMenu(user)}</Table.Cell> : null}
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
        </>
      )}

      {canManage ? (
        <>
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
          <SetPasswordDialog
            key={`password-${dialogKey}`}
            state={passwordState}
            target={target}
            onSaved={setData}
          />
          <ConfirmDialog
            state={deleteState}
            title={t("deleteTitle")}
            description={t("deleteConfirm", { username: target?.username ?? "" })}
            confirmLabel={tCommon("delete")}
            cancelLabel={tCommon("cancel")}
            onConfirm={() => {
              if (target) remove(target);
            }}
          />
        </>
      ) : null}
      {canBudget ? (
        <>
          <BudgetDialog
            key={`budget-${dialogKey}`}
            state={budgetState}
            target={budgetFor}
            budget={budgetFor?.budget ?? null}
            ancestors={budgetFor?.ancestors ?? []}
            onSubmit={setBudgetAction}
            onSaved={applyBudget}
          />
          <BoostDialog
            key={`boost-${dialogKey}`}
            state={boostState}
            target={budgetFor}
            budget={budgetFor?.budget ?? null}
            onSubmit={addBoostAction}
            onRemove={removeBoostAction}
            onSaved={applyBudget}
          />
        </>
      ) : null}
      {canSecure ? (
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
      ) : null}
    </div>
  );
}
