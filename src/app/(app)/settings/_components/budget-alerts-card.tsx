"use client";

import { useState, useTransition } from "react";
import { Button, Label, NumberField, Spinner, Tag, TagGroup, toast } from "@heroui/react";
import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { useErrorToast } from "@/components/console/use-error-toast";
import { saveBudgetAlertsAction } from "../_action";
import { SettingSection } from "./setting-fields";

export default function BudgetAlertsCard({
  thresholds,
  canManage,
  onSaved,
}: {
  thresholds: number[];
  canManage: boolean;
  onSaved: (thresholds: number[]) => void;
}) {
  const t = useTranslations("Settings.logging.budgetAlerts");
  const showError = useErrorToast();
  const format = useFormatter();
  const [draft, setDraft] = useState(90);
  const [pending, start] = useTransition();
  const next = Math.round(draft);
  const canAdd = Number.isFinite(next) && next > 0 && next <= 100 && !thresholds.includes(next);

  function save(list: number[]) {
    start(async () => {
      const result = await saveBudgetAlertsAction(list);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.thresholds);
      toast(t("saved"), { variant: "success" });
    });
  }

  return (
    <SettingSection title={t("title")} subtitle={t("hint")}>
      <TagGroup
        aria-label={t("title")}
        onRemove={canManage ? (keys) => save(thresholds.filter((value) => !keys.has(String(value)))) : undefined}
      >
        <TagGroup.List>
          {thresholds.map((value) => (
            <Tag key={value} id={String(value)} textValue={String(value)}>
              {format.number(value / 100, "percent")}
              {canManage && thresholds.length > 1 ? <Tag.RemoveButton aria-label={t("remove", { value })} /> : null}
            </Tag>
          ))}
        </TagGroup.List>
      </TagGroup>
      {canManage ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <NumberField
            value={draft}
            onChange={setDraft}
            minValue={0}
            maxValue={100}
            formatOptions={formats.number.percentPoints}
            isDisabled={pending}
            className="sm:max-w-48"
          >
            <Label>{t("add")}</Label>
            <NumberField.Group>
              <NumberField.DecrementButton />
              <NumberField.Input />
              <NumberField.IncrementButton />
            </NumberField.Group>
          </NumberField>
          <Button variant="secondary" isPending={pending} isDisabled={!canAdd} onPress={() => save([...thresholds, next])}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <Plus size={14} aria-hidden />}
                {t("addButton")}
              </>
            )}
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted">{t("addHint")}</p>
    </SettingSection>
  );
}
