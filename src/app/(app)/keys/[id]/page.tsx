"use client";

import { use, useState, useTransition } from "react";
import { Button, Chip, Dropdown, Spinner, toast, useOverlayState } from "@heroui/react";
import { KeyRound, MoreHorizontal, Pause, Play } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import BoostDialog from "@/components/budget/boost-dialog";
import BudgetDialog from "@/components/budget/budget-dialog";
import ConfirmDialog from "@/components/console/confirm-dialog";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useErrorToast } from "@/components/console/use-error-toast";
import KeyStateChip from "@/components/keys/key-state-chip";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { useRouter } from "@/i18n/routing";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { isActionFail } from "@/lib/http/action-result";
import { draftOfKey, keyFieldsOf } from "@/lib/keys/draft";
import { isKeyPaused, keyState } from "@/lib/keys/pause";
import type { KeyDetailPage, KeyOwner, KeySection, VirtualKeyView } from "@/types/keys";
import type { BudgetResult } from "@/types/structure";
import KeyDetailSkeleton from "./_components/key-detail-skeleton";
import KeySectionDialog from "./_components/key-section-dialog";
import { AccessTab, IntegrationsTab, LimitsTab, OverviewTab, SecurityTab } from "./_components/key-tabs";
import {
  addBoostAction,
  createKeyAction,
  loadKeyDetailAction,
  loadKeyMcpAccessAction,
  pauseKeyAction,
  removeBoostAction,
  resumeKeyAction,
  revokeKeyAction,
  rotateKeyAction,
  saveKeyMcpAccessAction,
  setBudgetAction,
  updateKeyAction,
} from "../_action";

const KEY_ACTIONS: KeyServerActions = {
  create: createKeyAction,
  update: updateKeyAction,
  pause: pauseKeyAction,
  resume: resumeKeyAction,
  rotate: rotateKeyAction,
  revoke: revokeKeyAction,
  loadMcp: loadKeyMcpAccessAction,
  saveMcp: saveKeyMcpAccessAction,
  setBudget: setBudgetAction,
};

function ownerAfter(data: KeyDetailPage, key: VirtualKeyView): KeyOwner {
  const kind = key.member_id ? "member" : key.project_id ? "project" : "internal";
  const target =
    kind === "project"
      ? data.options.projects.find((row) => row.id === key.project_id)
      : kind === "member"
        ? data.options.members.find((row) => row.id === key.member_id)
        : undefined;
  const sameOwner = kind === data.owner.kind && key.org_id === data.owner.orgId;
  return {
    kind,
    name: target?.alias ?? (sameOwner ? data.owner.name : data.selfName),
    orgId: key.org_id,
    orgAlias: data.options.orgs.find((row) => row.id === key.org_id)?.alias ?? "",
    teamAlias: data.options.teams.find((row) => row.id === key.team_id)?.alias ?? "",
  };
}

export default function KeyDetailRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations("Keys");
  const tDetail = useTranslations("Keys.detail");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const router = useRouter();
  const showError = useErrorToast();
  const now = useClock(60_000);
  const page = useActionData(() => loadKeyDetailAction(id));
  const { data, setData } = page;
  const [section, setSection] = useState<KeySection>("basics");
  const [dialogKey, setDialogKey] = useState(0);
  const [blocking, startBlock] = useTransition();
  const sectionState = useOverlayState();
  const budgetState = useOverlayState();
  const boostState = useOverlayState();
  const blockState = useOverlayState();
  const keyDialogs = useKeyDialogs({
    actions: KEY_ACTIONS,
    canBind: data?.canBind ?? false,
    canBudget: data?.canBudget ?? false,
    linkToDetail: false,
    onSaved: applyKey,
    onRevoked: () => router.push("/keys"),
  });

  function applyKey(row: VirtualKeyView) {
    setData((current) => ({
      ...current,
      key: row,
      owner: ownerAfter(current, row),
      templates: current.options.templates
        .filter((template) => row.templates.includes(template.id))
        .map((template) => ({ id: template.id, name: template.name })),
    }));
  }

  function applyBudget(result: BudgetResult) {
    setData((current) => ({
      ...current,
      key: {
        ...current.key,
        max_budget: result.budget.maxBudget,
        spend: result.budget.spend,
        budget_duration: result.budget.budgetDuration,
      },
      budget: current.budget ? { ...current.budget, budget: result.budget } : current.budget,
    }));
  }

  function edit(next: KeySection) {
    setSection(next);
    setDialogKey((n) => n + 1);
    sectionState.open();
  }

  function toggleBlock(key: VirtualKeyView) {
    startBlock(async () => {
      const result = await updateKeyAction({ ...keyFieldsOf(draftOfKey(key)), id: key.token_id, blocked: !key.blocked });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      applyKey(result.key);
      toast(tDetail("blockedToast", { blocked: result.key.blocked ? "yes" : "no" }), { variant: "success" });
    });
  }

  const back = { href: "/keys", label: tDetail("back") };

  if (!data) {
    if (page.error === null) return <KeyDetailSkeleton />;
    return <PageStatus icon={KeyRound} back={back} title={t("title")} state={page} />;
  }

  const { key, owner } = data;
  const name = key.key_alias || key.key_name;
  const target = { id: key.token_id, name };
  const paused = isKeyPaused({ paused: key.paused, pausedUntil: key.paused_until }, now);
  const state = keyState({ blocked: key.blocked, paused: key.paused, pausedUntil: key.paused_until }, now);
  const expires = key.expires ? new Date(key.expires) : null;
  const busy = keyDialogs.busy;
  const place = t("binding.place", { org: owner.orgAlias, team: owner.teamAlias, hasTeam: owner.teamAlias ? "yes" : "no" });
  const subtitle = tDetail("subtitle", {
    kind: owner.kind,
    name: owner.name || tCommon("none"),
    hasPlace: owner.orgAlias ? "yes" : "no",
    place,
  });
  const menuItems = [
    ...(data.canManage ? [{ id: "rotate", label: t("rotate") }] : []),
    ...(data.canMcp ? [{ id: "mcp", label: t("mcp.action") }] : []),
    ...(data.canManage ? [{ id: "block", label: tDetail("blockAction", { blocked: key.blocked ? "yes" : "no" }) }] : []),
    ...(data.canManage ? [{ id: "revoke", label: t("revoke") }] : []),
  ];

  const actions =
    data.canManage || menuItems.length ? (
      <>
        {data.canManage ? (
          <Button
            variant="secondary"
            isPending={busy?.action === "resume"}
            isDisabled={busy !== null || blocking}
            onPress={() => (paused ? keyDialogs.resume(target) : keyDialogs.askPause(target))}
          >
            {({ isPending }) => (
              <>
                {isPending ? (
                  <Spinner color="current" size="sm" />
                ) : paused ? (
                  <Play size={16} aria-hidden />
                ) : (
                  <Pause size={16} aria-hidden />
                )}
                {paused ? t("resume") : t("pause.action")}
              </>
            )}
          </Button>
        ) : null}
        {menuItems.length ? (
          <Dropdown>
            <Button
              variant="tertiary"
              isPending={blocking || busy?.action === "revoke" || busy?.action === "rotate"}
              aria-label={t("actionsMenu", { name })}
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={16} aria-hidden />}
                  {tDetail("more")}
                </>
              )}
            </Button>
            <Dropdown.Popover>
              <Dropdown.Menu
                aria-label={t("actionsMenu", { name })}
                onAction={(action) => {
                  if (action === "rotate") keyDialogs.askRotate(target);
                  if (action === "mcp") keyDialogs.openMcp(target);
                  if (action === "block") {
                    if (key.blocked) toggleBlock(key);
                    else blockState.open();
                  }
                  if (action === "revoke") keyDialogs.askRevoke(target);
                }}
              >
                {menuItems.map((item) => (
                  <Dropdown.Item
                    key={item.id}
                    id={item.id}
                    textValue={item.label}
                    variant={item.id === "revoke" ? "danger" : "default"}
                  >
                    {item.label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
      </>
    ) : undefined;

  const tabs = [
    {
      id: "overview",
      label: tDetail("tab", { tab: "overview" }),
      panel: <OverviewTab data={data} now={now} onEdit={edit} />,
    },
    { id: "access", label: tDetail("tab", { tab: "access" }), panel: <AccessTab data={data} now={now} onEdit={edit} /> },
    {
      id: "limits",
      label: tDetail("tab", { tab: "limits" }),
      panel: (
        <LimitsTab
          data={data}
          now={now}
          onEdit={edit}
          onBudget={() => budgetState.open()}
          onBoost={() => boostState.open()}
        />
      ),
    },
    {
      id: "security",
      label: tDetail("tab", { tab: "security" }),
      panel: <SecurityTab data={data} now={now} onEdit={edit} />,
    },
    ...(data.canMcp
      ? [
          {
            id: "integrations",
            label: tDetail("tab", { tab: "integrations" }),
            panel: <IntegrationsTab onMcp={() => keyDialogs.openMcp(target)} />,
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader icon={KeyRound} back={back} title={name} subtitle={subtitle} actions={actions} />
      <div className="-mt-4 mb-6 flex flex-wrap items-center gap-2">
        <KeyStateChip state={state} pausedUntil={key.paused_until} />
        <Chip size="sm" variant="soft">
          <span className="font-mono">{key.key_name}…</span>
        </Chip>
        {key.log_content ? null : (
          <Chip size="sm" variant="soft" color="warning">
            {t("contentOff")}
          </Chip>
        )}
        {expires ? (
          <Chip size="sm" variant="soft" color={expires <= now ? "danger" : "default"}>
            {tDetail("expiresChip", { expired: expires <= now ? "yes" : "no", date: format.dateTime(expires, "short") })}
          </Chip>
        ) : null}
      </div>
      <PageTabs label={tDetail("tabsLabel")} tabs={tabs} />

      {data.canManage ? (
        <KeySectionDialog
          key={`section-${dialogKey}`}
          state={sectionState}
          section={section}
          keyView={key}
          options={data.options}
          canBind={data.canBind}
          onSaved={applyKey}
        />
      ) : null}
      {data.canBudget && data.budget ? (
        <>
          <BudgetDialog
            key={`budget-${dialogKey}-${key.max_budget}`}
            state={budgetState}
            target={{ kind: "key", id: key.token_id, alias: name }}
            budget={data.budget.budget}
            ancestors={data.budget.ancestors}
            onSubmit={setBudgetAction}
            onSaved={applyBudget}
          />
          <BoostDialog
            key={`boost-${dialogKey}`}
            state={boostState}
            target={{ kind: "key", id: key.token_id, alias: name }}
            budget={data.budget.budget}
            onSubmit={addBoostAction}
            onRemove={removeBoostAction}
            onSaved={applyBudget}
          />
        </>
      ) : null}
      <ConfirmDialog
        state={blockState}
        status="warning"
        title={tDetail("blockConfirm.title", { name })}
        description={tDetail("blockConfirm.description")}
        confirmLabel={tDetail("blockAction", { blocked: "no" })}
        cancelLabel={tCommon("cancel")}
        onConfirm={() => toggleBlock(key)}
      />
      {keyDialogs.dialogs}
    </div>
  );
}
