"use client";

import { useState, useTransition } from "react";
import { Button, Card, Spinner, Table } from "@heroui/react";
import { ChevronRight, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import RowCard, { RowCards, TABLE_FROM_XL } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import KeyMenu, { keyMenuActions, type KeyMenuAction } from "@/components/keys/key-menu";
import KeyStateChip from "@/components/keys/key-state-chip";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { isActionFail } from "@/lib/http/action-result";
import { useClock } from "@/lib/hooks/use-clock";
import { isKeyPaused, keyState } from "@/lib/keys/pause";
import type { ActionFail } from "@/types/actions";
import type { KeyChoices, KeyDetail, KeyPreset, VirtualKeyView } from "@/types/keys";
import type { BudgetTarget, KeyNode, NodeRef, StructurePayload, TenancyKind } from "@/types/structure";
import { keyOptionsOf } from "./key-model";
import { nodeAlias } from "./tree-model";

export default function KeysCard({
  data,
  keys,
  kind,
  preset,
  actions,
  loadKey,
  loadChoices,
  onOpen,
  onBudget,
  onChanged,
  onRevoked,
}: {
  data: StructurePayload;
  keys: KeyNode[];
  kind: TenancyKind;
  preset: KeyPreset | null;
  actions: KeyServerActions;
  loadKey: (id: string) => Promise<KeyDetail | ActionFail>;
  loadChoices: () => Promise<KeyChoices | null>;
  onOpen: (ref: NodeRef) => void;
  onBudget: (target: BudgetTarget, dialog: "budget" | "boost") => void;
  onChanged: (key: VirtualKeyView) => void;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("Companies.keys");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const now = useClock(60_000);
  const [opening, setOpening] = useState<string | null>(null);
  const [, start] = useTransition();
  const keyDialogs = useKeyDialogs({ actions, canBind: data.canManage, onSaved: onChanged, onRevoked });
  const flags = { canManage: data.canManageKeys, canMcp: data.canMcp, canBudget: data.canBudget };

  function create(next: KeyPreset) {
    setOpening("create");
    start(async () => {
      const choices = await loadChoices();
      setOpening(null);
      if (choices) keyDialogs.openCreate(keyOptionsOf(data, choices), next);
    });
  }

  function edit(key: KeyNode) {
    setOpening(key.id);
    start(async () => {
      const [choices, detail] = await Promise.all([loadChoices(), loadKey(key.id)]);
      setOpening(null);
      if (isActionFail(detail)) {
        showError(detail.error);
        return;
      }
      if (choices) keyDialogs.openEdit(keyOptionsOf(data, choices), detail.key);
    });
  }

  function run(key: KeyNode, action: KeyMenuAction) {
    const target = { id: key.id, name: key.alias };
    if (action === "edit") edit(key);
    if (action === "pause") keyDialogs.askPause(target);
    if (action === "resume") keyDialogs.resume(target);
    if (action === "mcp") keyDialogs.openMcp(target);
    if (action === "budget" || action === "boost") onBudget({ kind: "key", id: key.id, alias: key.alias }, action);
    if (action === "rotate") keyDialogs.askRotate(target);
    if (action === "revoke") keyDialogs.askRevoke(target);
  }

  function owner(key: KeyNode) {
    if (key.memberId) return { kind: "member", name: nodeAlias(data, "member", key.memberId) };
    if (key.projectId) return { kind: "project", name: nodeAlias(data, "project", key.projectId) };
    return { kind: "internal", name: nodeAlias(data, "user", key.userId) };
  }

  function stateChip(key: KeyNode) {
    const state = keyState(key, now);
    if (state === "active") return null;
    return <KeyStateChip state={state} pausedUntil={key.pausedUntil} />;
  }

  function spendLabel(key: KeyNode) {
    return tCommon("spendBudget", {
      hasCap: key.budget.maxBudget > 0 ? "yes" : "no",
      spend: key.budget.spend,
      budget: key.budget.maxBudget + key.budget.boost,
    });
  }

  function rowActions(key: KeyNode) {
    return (
      <>
        <KeyMenu
          name={key.alias}
          actions={keyMenuActions(flags, { capped: key.budget.maxBudget > 0, paused: isKeyPaused(key, now) })}
          pending={opening === key.id || keyDialogs.busy?.id === key.id}
          isDisabled={opening !== null && opening !== key.id}
          onAction={(action) => run(key, action)}
        />
        <Button
          isIconOnly
          size="sm"
          variant="ghost"
          aria-label={t("open", { alias: key.alias })}
          onPress={() => onOpen({ kind: "key", id: key.id })}
        >
          <ChevronRight size={14} aria-hidden />
        </Button>
      </>
    );
  }

  function ownerValue(key: KeyNode) {
    const bound = owner(key);
    return (
      <>
        {bound.name || tCommon("none")}
        <span className="block text-xs text-muted">{t("ownerKind", { kind: bound.kind })}</span>
      </>
    );
  }

  return (
    <>
      <Card>
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title>{t("title", { count: keys.length })}</Card.Title>
            <Card.Description>{t("hint", { kind })}</Card.Description>
          </div>
          {preset && data.canCreateKeys ? (
            <Button size="sm" isPending={opening === "create"} onPress={() => create(preset)}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <Plus size={14} aria-hidden />}
                  {t("create")}
                </>
              )}
            </Button>
          ) : null}
        </Card.Header>
        <Card.Content className="space-y-4">
          {keyDialogs.notice}
          {keys.length === 0 ? (
            <p className="text-sm text-muted">{t("empty", { kind })}</p>
          ) : (
            <>
              <RowCards label={t("title", { count: keys.length })} until="xl">
                {keys.map((key) => (
                  <RowCard
                    key={key.id}
                    variant="secondary"
                    title={key.alias}
                    description={<span className="font-mono text-xs">{key.prefix}…</span>}
                    aside={rowActions(key)}
                    chips={stateChip(key)}
                    details={[
                      { label: t("columns.owner"), value: ownerValue(key) },
                      { label: t("columns.budget"), value: spendLabel(key) },
                    ]}
                  />
                ))}
              </RowCards>
              <Table aria-label={t("title", { count: keys.length })} className={TABLE_FROM_XL}>
                <Table.ScrollContainer>
                  <Table.Content className="min-w-xl">
                    <Table.Header>
                      <Table.Column isRowHeader>{t("columns.key")}</Table.Column>
                      <Table.Column>{t("columns.owner")}</Table.Column>
                      <Table.Column>{t("columns.budget")}</Table.Column>
                      <Table.Column>{tCommon("actions")}</Table.Column>
                    </Table.Header>
                    <Table.Body>
                      {keys.map((key) => (
                        <Table.Row key={key.id} id={key.id}>
                          <Table.Cell>
                            <div className="min-w-0">
                              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                {key.alias}
                                {stateChip(key)}
                              </p>
                              <p className="font-mono text-xs text-muted">{key.prefix}…</p>
                            </div>
                          </Table.Cell>
                          <Table.Cell>
                            <div className="min-w-0 text-sm">{ownerValue(key)}</div>
                          </Table.Cell>
                          <Table.Cell>{spendLabel(key)}</Table.Cell>
                          <Table.Cell>
                            <div className="flex gap-1">{rowActions(key)}</div>
                          </Table.Cell>
                        </Table.Row>
                      ))}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </>
          )}
        </Card.Content>
      </Card>
      {keyDialogs.dialogs}
    </>
  );
}
