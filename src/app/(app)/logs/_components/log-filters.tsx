"use client";

import { useState } from "react";
import {
  Button,
  Card,
  ComboBox,
  Description,
  Disclosure,
  FieldError,
  Form,
  Input,
  Label,
  ListBox,
  Spinner,
  Switch,
  TextField,
} from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { BELOW_MD, useMediaQuery } from "@/lib/hooks/use-media-query";
import { parseLabelFilter, storedLabel } from "@/lib/usage/labels";
import type { PickerItem } from "@/types/console";
import type { LogFilterValues, LogOption, LogOptions } from "@/types/logs";

export const NO_FILTERS: LogFilterValues = {
  model: "",
  status: "",
  endpoint: "",
  keyId: "",
  userId: "",
  label: "",
  pii: false,
  from: "",
  to: "",
};

function activeCount(filters: LogFilterValues): number {
  return Object.values(filters).filter((value) => value === true || (typeof value === "string" && value !== "")).length;
}

export default function LogFilters({
  pending,
  options,
  initial,
  onApply,
}: {
  pending: boolean;
  options: LogOptions;
  initial: LogFilterValues;
  onApply: (filters: LogFilterValues) => void;
}) {
  const t = useTranslations("Logs");
  const [values, setValues] = useState<LogFilterValues>(initial);
  const [applied, setApplied] = useState(() => activeCount(initial));
  const [expanded, setExpanded] = useState(false);
  const compact = useMediaQuery(BELOW_MD);
  const label = values.label.trim() ? parseLabelFilter(values.label) : null;
  const labelInvalid = values.label.trim() !== "" && !label;
  const set = <K extends keyof LogFilterValues>(key: K) => (value: LogFilterValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));
  const withSelected = (listed: LogOption[], id: string, kind: "key" | "user"): PickerItem[] =>
    !id || listed.some((option) => option.id === id)
      ? listed
      : [...listed, { id, label: t("filters.selected", { kind }), detail: id }];

  const form = (
    <Form
      className={compact ? "space-y-4" : "mb-4 space-y-4"}
      onSubmit={(event) => {
        event.preventDefault();
        if (labelInvalid) return;
        const next = {
          ...values,
          model: values.model.trim(),
          status: values.status.trim(),
          endpoint: values.endpoint.trim(),
          label: label ? storedLabel(label) : "",
        };
        setApplied(activeCount(next));
        onApply(next);
      }}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <ComboBox fullWidth allowsCustomValue inputValue={values.model} onInputChange={set("model")}>
          <Label>{t("columns.model")}</Label>
          <ComboBox.InputGroup>
            <Input />
            <ComboBox.Trigger />
          </ComboBox.InputGroup>
          <ComboBox.Popover>
            <ListBox aria-label={t("columns.model")}>
              {options.models.map((alias) => (
                <ListBox.Item key={alias} id={alias} textValue={alias}>
                  {alias}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </ComboBox.Popover>
        </ComboBox>
        <TextField fullWidth value={values.endpoint} onChange={set("endpoint")}>
          <Label>{t("columns.endpoint")}</Label>
          <Input placeholder="/v1/chat/completions" />
        </TextField>
        <TextField fullWidth value={values.status} onChange={set("status")}>
          <Label>{t("columns.status")}</Label>
          <Input inputMode="numeric" />
        </TextField>
        <SearchSelect
          label={t("filters.key")}
          items={[{ id: "all", label: t("filters.anyKey") }, ...withSelected(options.keys, values.keyId, "key")]}
          value={values.keyId || "all"}
          onChange={(next) => set("keyId")(next === "all" ? "" : next)}
        />
        {options.users.length || values.userId ? (
          <SearchSelect
            label={t("filters.user")}
            items={[{ id: "all", label: t("filters.anyUser") }, ...withSelected(options.users, values.userId, "user")]}
            value={values.userId || "all"}
            onChange={(next) => set("userId")(next === "all" ? "" : next)}
          />
        ) : null}
        <TextField fullWidth value={values.label} onChange={set("label")} isInvalid={labelInvalid} maxLength={200}>
          <Label>{t("filters.label")}</Label>
          <Input placeholder="cost_center:4711" />
          {labelInvalid ? null : <Description>{t("filters.labelHint")}</Description>}
          <FieldError>{t("filters.labelInvalid")}</FieldError>
        </TextField>
        <TextField fullWidth value={values.from} onChange={set("from")}>
          <Label>{t("filters.from")}</Label>
          <Input type="date" />
        </TextField>
        <TextField fullWidth value={values.to} onChange={set("to")}>
          <Label>{t("filters.to")}</Label>
          <Input type="date" />
        </TextField>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Switch isSelected={values.pii} onChange={set("pii")}>
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("filters.pii")}</Label>
          </Switch.Content>
        </Switch>
        <Button type="submit" variant="secondary" isPending={pending}>
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("filters.apply")}
            </>
          )}
        </Button>
        <Button
          variant="tertiary"
          isDisabled={pending}
          onPress={() => {
            setValues(NO_FILTERS);
            setApplied(0);
            onApply(NO_FILTERS);
          }}
        >
          {t("filters.reset")}
        </Button>
      </div>
    </Form>
  );

  if (!compact) return form;
  return (
    <Card className="mb-4">
      <Disclosure isExpanded={expanded} onExpandedChange={setExpanded}>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 text-sm font-medium">
            <span className="flex items-center gap-2">
              <SlidersHorizontal size={14} aria-hidden />
              {t("filters.title", { count: applied })}
            </span>
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="pt-4">{form}</Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
    </Card>
  );
}
