"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Table, toast, useOverlayState } from "@heroui/react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import { isActionFail } from "@/lib/http/action-result";
import type { GuardrailOverrideView, GuardrailPolicy, PolicyScope, PolicyTarget } from "@/types/guardrails";
import { saveGuardrailOverrideAction } from "../_action";
import GuardrailOverrideDialog from "./guardrail-override-dialog";
import PolicyPrecedence from "./policy-precedence";
import { inheritedPolicy } from "./policy-target-picker";

type OverrideResult = { scope: PolicyScope; id: string; override: GuardrailOverrideView | null };

export default function GuardrailOverrides({
  overrides,
  targets,
  global,
  canManage,
  onChanged,
}: {
  overrides: GuardrailOverrideView[];
  targets: PolicyTarget[];
  global: GuardrailPolicy;
  canManage: boolean;
  onChanged: (result: OverrideResult) => void;
}) {
  const t = useTranslations("Guardrails");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [editing, setEditing] = useState<GuardrailOverrideView | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [pending, start] = useTransition();
  const dialogState = useOverlayState();
  const taken = new Set(overrides.map((row) => `${row.scope}:${row.id}`));
  const available = targets.filter((row) => !taken.has(`${row.scope}:${row.id}`));

  function openDialog(row: GuardrailOverrideView | null) {
    setEditing(row);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  function remove(row: GuardrailOverrideView) {
    start(async () => {
      const result = await saveGuardrailOverrideAction({ scope: row.scope, id: row.id, policy: null });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onChanged(result);
      toast(t("overrideSaved", { mode: "removed" }), { variant: "success" });
    });
  }

  return (
    <Card className="mb-6 gap-4">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <Card.Title>{t("overrides")}</Card.Title>
          <Card.Description>{t("content.overridesHint")}</Card.Description>
        </div>
        {canManage && available.length ? (
          <Button size="sm" onPress={() => openDialog(null)}>
            <Plus size={14} aria-hidden />
            {t("addOverride")}
          </Button>
        ) : null}
      </Card.Header>
      <PolicyPrecedence note={t("content.replace")} />
      {overrides.length === 0 ? (
        <p className="text-sm text-muted">{t("content.overridesEmpty")}</p>
      ) : (
        <Table aria-label={t("overrides")}>
          <Table.ScrollContainer>
            <Table.Content>
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                <Table.Column>{t("scope")}</Table.Column>
                <Table.Column>{t("injection.title")}</Table.Column>
                <Table.Column>{t("secrets.title")}</Table.Column>
                <Table.Column>{t("rules.title")}</Table.Column>
                {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
              </Table.Header>
              <Table.Body>
                {overrides.map((row) => (
                  <Table.Row key={`${row.scope}:${row.id}`} id={`${row.scope}:${row.id}`}>
                    <Table.Cell>{row.alias}</Table.Cell>
                    <Table.Cell>{t("scopeLabel", { scope: row.scope })}</Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" variant="soft" color={row.policy.injection.enabled ? "success" : "default"}>
                        {t("content.state", {
                          enabled: String(row.policy.injection.enabled),
                          action: row.policy.injection.action,
                        })}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>
                      <Chip size="sm" variant="soft" color={row.policy.secrets.enabled ? "success" : "default"}>
                        {t("content.state", {
                          enabled: String(row.policy.secrets.enabled),
                          action: row.policy.secrets.action,
                        })}
                      </Chip>
                    </Table.Cell>
                    <Table.Cell>{t("rules.count", { count: row.policy.rules.length })}</Table.Cell>
                    {canManage ? (
                      <Table.Cell>
                        <div className="flex flex-wrap gap-1">
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-label={tCommon("edit")}
                            onPress={() => openDialog(row)}
                          >
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
                            <Button
                              isIconOnly
                              size="sm"
                              variant="danger-soft"
                              aria-label={t("removeOverride")}
                              isPending={pending}
                            >
                              <Trash2 size={14} aria-hidden />
                            </Button>
                          </ConfirmDialog>
                        </div>
                      </Table.Cell>
                    ) : null}
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}
      <GuardrailOverrideDialog
        key={`guardrail-override-${dialogKey}`}
        state={dialogState}
        editing={editing}
        targets={available}
        inherited={(target) => inheritedPolicy(target, overrides, global)}
        onSaved={onChanged}
      />
    </Card>
  );
}
