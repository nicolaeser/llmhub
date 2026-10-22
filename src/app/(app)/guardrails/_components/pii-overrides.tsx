"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Table, toast, useOverlayState } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { isActionFail } from "@/lib/http/action-result";
import type { PiiOverrideView, PiiPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";
import { savePiiOverrideAction } from "../_action";
import PiiOverrideDialog from "./pii-override-dialog";
import PolicyPrecedence from "./policy-precedence";
import { inheritedPolicy } from "./policy-target-picker";
import { useErrorToast } from "@/components/console/use-error-toast";

type OverrideResult = { scope: PolicyScope; id: string; override: PiiOverrideView | null };

export default function PiiOverrides({
  overrides,
  targets,
  global,
  canManage,
  onChanged,
}: {
  overrides: PiiOverrideView[];
  targets: PolicyTarget[];
  global: PiiPolicy;
  canManage: boolean;
  onChanged: (result: OverrideResult) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [editing, setEditing] = useState<PiiOverrideView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [pending, start] = useTransition();
  const dialogState = useOverlayState();
  const taken = new Set(overrides.map((row) => `${row.scope}:${row.id}`));
  const available = targets.filter((row) => !taken.has(`${row.scope}:${row.id}`));

  function inherited(target: PolicyTarget): PiiPolicy {
    return inheritedPolicy(target, overrides, global);
  }

  function openDialog(row: PiiOverrideView | null) {
    setEditing(row);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  function remove(row: PiiOverrideView) {
    start(async () => {
      const result = await savePiiOverrideAction({ scope: row.scope, id: row.id, policy: null });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onChanged(result);
      toast(t("overrideSaved", { mode: "removed" }), { variant: "success" });
    });
  }

  function modeChip(row: PiiOverrideView) {
    return (
      <Chip size="sm" variant="soft" color={row.policy.enabled ? "success" : "warning"}>
        {t("modeState", { state: row.policy.enabled ? row.policy.mode : "off" })}
      </Chip>
    );
  }

  function outputLabel(row: PiiOverrideView) {
    return t("outputState", { output: row.policy.enabled && row.policy.output ? "true" : "false" });
  }

  function detectorLabel(row: PiiOverrideView) {
    return t("detectorOption", { detector: row.policy.detector });
  }

  function overrideActions(row: PiiOverrideView) {
    return (
      <>
        <Button size="sm" variant="secondary" aria-label={tCommon("edit")} onPress={() => openDialog(row)}>
          {tCommon("edit")}
        </Button>
        <ConfirmDialog
          title={t("removeConfirm", { alias: row.alias })}
          description={t("removeConfirmHint")}
          confirmLabel={t("removeOverride")}
          cancelLabel={tCommon("cancel")}
          pending={pending}
          onConfirm={() => remove(row)}
        >
          <Button isIconOnly size="sm" variant="danger-soft" aria-label={t("removeOverride")} isPending={pending}>
            <Trash2 size={14} aria-hidden />
          </Button>
        </ConfirmDialog>
      </>
    );
  }

  return (
    <Card className="mb-6 gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <Card.Title>{t("overrides")}</Card.Title>
          <Card.Description>{t("overridesHint")}</Card.Description>
        </div>
        {canManage && available.length ? (
          <Button size="sm" onPress={() => openDialog(null)}>
            <Plus size={14} aria-hidden />
            {t("addOverride")}
          </Button>
        ) : null}
      </Card.Header>
      <PolicyPrecedence note={t("precedence.replace")} />
      {overrides.length === 0 ? (
        <p className="text-sm text-muted">{t("overridesEmpty")}</p>
      ) : (
        <>
          <RowCards label={t("overrides")}>
            {overrides.map((row) => (
              <RowCard
                key={`${row.scope}:${row.id}`}
                variant="secondary"
                title={row.alias}
                description={t("scopeLabel", { scope: row.scope })}
                aside={modeChip(row)}
                details={[
                  { label: t("entities"), value: t("entityCount", { count: row.policy.entities.length }) },
                  { label: t("columns.output"), value: outputLabel(row) },
                  { label: t("detector"), value: detectorLabel(row) },
                ]}
                actions={canManage ? overrideActions(row) : undefined}
              />
            ))}
          </RowCards>
          <Table aria-label={t("overrides")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                  <Table.Column>{t("scope")}</Table.Column>
                  <Table.Column>{t("mode")}</Table.Column>
                  <Table.Column>{t("entities")}</Table.Column>
                  <Table.Column>{t("columns.output")}</Table.Column>
                  <Table.Column>{t("detector")}</Table.Column>
                  {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {overrides.map((row) => (
                    <Table.Row key={`${row.scope}:${row.id}`} id={`${row.scope}:${row.id}`}>
                      <Table.Cell>{row.alias}</Table.Cell>
                      <Table.Cell>{t("scopeLabel", { scope: row.scope })}</Table.Cell>
                      <Table.Cell>{modeChip(row)}</Table.Cell>
                      <Table.Cell>{t("entityCount", { count: row.policy.entities.length })}</Table.Cell>
                      <Table.Cell>{outputLabel(row)}</Table.Cell>
                      <Table.Cell>{detectorLabel(row)}</Table.Cell>
                      {canManage ? (
                        <Table.Cell>
                          <div className="flex flex-wrap gap-1">{overrideActions(row)}</div>
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
      <PiiOverrideDialog
        key={`override-${dialogKey}`}
        state={dialogState}
        editing={editing}
        targets={available}
        inherited={inherited}
        onSaved={onChanged}
      />
    </Card>
  );
}
