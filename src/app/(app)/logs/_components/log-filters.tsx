"use client";

import { useState } from "react";
import { Button, Form, Input, Label, ListBox, Select, Spinner, Switch, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import type { LogFilterValues, LogOption, LogOptions } from "@/types/logs";

export const NO_FILTERS: LogFilterValues = {
  model: "",
  status: "",
  endpoint: "",
  keyId: "",
  userId: "",
  pii: false,
  from: "",
  to: "",
};

function OptionSelect({
  label,
  anyLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  anyLabel: string;
  value: string;
  options: LogOption[];
  onChange: (value: string) => void;
}) {
  return (
    <Select
      selectedKey={value || "all"}
      onSelectionChange={(key) => onChange(String(key) === "all" ? "" : String(key))}
      fullWidth
    >
      <Label>{label}</Label>
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          <ListBox.Item id="all" textValue={anyLabel}>
            {anyLabel}
            <ListBox.ItemIndicator />
          </ListBox.Item>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export default function LogFilters({
  pending,
  options,
  onApply,
}: {
  pending: boolean;
  options: LogOptions;
  onApply: (filters: LogFilterValues) => void;
}) {
  const t = useTranslations("Logs");
  const [values, setValues] = useState<LogFilterValues>(NO_FILTERS);
  const set = <K extends keyof LogFilterValues>(key: K) => (value: LogFilterValues[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <Form
      className="mb-4 space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({ ...values, model: values.model.trim(), status: values.status.trim(), endpoint: values.endpoint.trim() });
      }}
    >
      <div className="grid gap-3 md:grid-cols-4">
        <TextField fullWidth value={values.model} onChange={set("model")}>
          <Label>{t("columns.model")}</Label>
          <Input />
        </TextField>
        <TextField fullWidth value={values.endpoint} onChange={set("endpoint")}>
          <Label>{t("columns.endpoint")}</Label>
          <Input placeholder="/v1/chat/completions" />
        </TextField>
        <TextField fullWidth value={values.status} onChange={set("status")}>
          <Label>{t("columns.status")}</Label>
          <Input inputMode="numeric" />
        </TextField>
        <OptionSelect
          label={t("filters.key")}
          anyLabel={t("filters.anyKey")}
          value={values.keyId}
          options={options.keys}
          onChange={set("keyId")}
        />
        {options.users.length ? (
          <OptionSelect
            label={t("filters.user")}
            anyLabel={t("filters.anyUser")}
            value={values.userId}
            options={options.users}
            onChange={set("userId")}
          />
        ) : null}
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
            onApply(NO_FILTERS);
          }}
        >
          {t("filters.reset")}
        </Button>
      </div>
    </Form>
  );
}
