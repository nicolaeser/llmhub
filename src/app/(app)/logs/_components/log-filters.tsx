"use client";

import { useState } from "react";
import { Button, ComboBox, Form, Input, Label, ListBox, Spinner, Switch, TextField } from "@heroui/react";
import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import type { LogFilterValues, LogOptions } from "@/types/logs";

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
          items={[{ id: "all", label: t("filters.anyKey") }, ...options.keys]}
          value={values.keyId || "all"}
          onChange={(next) => set("keyId")(next === "all" ? "" : next)}
        />
        {options.users.length ? (
          <SearchSelect
            label={t("filters.user")}
            items={[{ id: "all", label: t("filters.anyUser") }, ...options.users]}
            value={values.userId || "all"}
            onChange={(next) => set("userId")(next === "all" ? "" : next)}
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
