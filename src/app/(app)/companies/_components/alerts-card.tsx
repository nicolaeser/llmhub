"use client";

import { useState, useTransition } from "react";
import {
  Button,
  Card,
  Label,
  NumberField,
  Spinner,
  Tag,
  TagGroup,
  toast,
} from "@heroui/react";
import { Plus } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { isActionFail } from "@/lib/http/action-result";
import { saveBudgetAlertsAction } from "../_action";

export default function AlertsCard({
  thresholds,
  onSaved,
}: {
  thresholds: number[];
  onSaved: (thresholds: number[]) => void;
}) {
  const t = useTranslations("Companies.alerts");
  const tError = useTranslations("Error");
  const format = useFormatter();
  const [draft, setDraft] = useState(90);
  const [pending, start] = useTransition();
  const next = Math.round(draft);
  const canAdd = Number.isFinite(next) && next > 0 && next <= 100 && !thresholds.includes(next);

  function save(list: number[]) {
    start(async () => {
      const result = await saveBudgetAlertsAction(list);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      onSaved(result.thresholds);
      toast(t("saved"), { variant: "success" });
    });
  }

  return (
    <Card>
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("hint")}</Card.Description>
      </Card.Header>
      <Card.Content className="space-y-4">
        <TagGroup
          aria-label={t("title")}
          onRemove={(keys) =>
            save(thresholds.filter((value) => !keys.has(String(value))))
          }
        >
          <TagGroup.List>
            {thresholds.map((value) => (
              <Tag key={value} id={String(value)} textValue={String(value)}>
                {format.number(value / 100, "percent")}
                {thresholds.length > 1 ? (
                  <Tag.RemoveButton aria-label={t("remove", { value })} />
                ) : null}
              </Tag>
            ))}
          </TagGroup.List>
        </TagGroup>
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
          <Button
            variant="secondary"
            isPending={pending}
            isDisabled={!canAdd}
            onPress={() => save([...thresholds, next])}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <Plus size={14} aria-hidden />}
                {t("addButton")}
              </>
            )}
          </Button>
        </div>
        <p className="text-xs text-muted">{t("addHint")}</p>
      </Card.Content>
    </Card>
  );
}
