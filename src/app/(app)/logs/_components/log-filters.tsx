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
  session: "",
  pii: false,
  from: "",
  to: "",
};

const MORE_FILTERS = ["endpoint", "userId", "label", "session", "pii"] as const satisfies readonly (keyof LogFilterValues)[];

function isSet(value: LogFilterValues[keyof LogFilterValues]): boolean {
  return value === true || (typeof value === "string" && value !== "");
}

export function activeCount(filters: LogFilterValues): number {
  return Object.values(filters).filter(isSet).length;
}

export function moreCount(filters: LogFilterValues): number {
  return MORE_FILTERS.filter((key) => isSet(filters[key])).length;
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
  const [moreOpen, setMoreOpen] = useState(() => moreCount(initial) > 0);
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
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (labelInvalid) return;
        const next = {
          ...values,
          model: values.model.trim(),
          status: values.status.trim(),
          endpoint: values.endpoint.trim(),
          label: label ? storedLabel(label) : "",
          session: values.session.trim(),
        };
        setApplied(activeCount(next));
        onApply(next);
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <ComboBox fullWidth allowsCustomValue inputValue={values.model} onInputChange={set("model")}>
          <Label>{t("columns.model")}</Label>
          <ComboBox.InputGroup>
            <Input placeholder={t("filters.anyModel")} />
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
        <TextField fullWidth value={values.status} onChange={set("status")}>
          <Label>{t("columns.status")}</Label>
          <Input inputMode="numeric" placeholder={t("filters.statusPlaceholder")} />
        </TextField>
        <SearchSelect
          label={t("filters.key")}
          items={[{ id: "all", label: t("filters.anyKey") }, ...withSelected(options.keys, values.keyId, "key")]}
          value={values.keyId || "all"}
          onChange={(next) => set("keyId")(next === "all" ? "" : next)}
        />
        <TextField fullWidth value={values.from} onChange={set("from")}>
          <Label>{t("filters.from")}</Label>
          <Input type="date" />
        </TextField>
        <TextField fullWidth value={values.to} onChange={set("to")}>
          <Label>{t("filters.to")}</Label>
          <Input type="date" />
        </TextField>
      </div>
      <Disclosure isExpanded={moreOpen} onExpandedChange={setMoreOpen}>
        <Disclosure.Heading>
          <Disclosure.Trigger className="flex items-center gap-2 text-sm font-medium text-muted">
            {t("filters.more", { count: moreCount(values) })}
            <Disclosure.Indicator />
          </Disclosure.Trigger>
        </Disclosure.Heading>
        <Disclosure.Content>
          <Disclosure.Body className="grid gap-3 pt-3 md:grid-cols-2 xl:grid-cols-4">
            <TextField fullWidth value={values.endpoint} onChange={set("endpoint")}>
              <Label>{t("columns.endpoint")}</Label>
              <Input placeholder="/v1/chat/completions" />
            </TextField>
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
            <TextField fullWidth value={values.session} onChange={set("session")}>
              <Label>{t("filters.session")}</Label>
              <Input placeholder={t("filters.sessionPlaceholder")} />
            </TextField>
            <div className="md:col-span-2 xl:col-span-4">
              <Switch isSelected={values.pii} onChange={set("pii")}>
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>{t("filters.pii")}</Label>
                </Switch.Content>
              </Switch>
            </div>
          </Disclosure.Body>
        </Disclosure.Content>
      </Disclosure>
      <div className="flex flex-wrap items-center gap-3">
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

  if (!compact) {
    return (
      <Card className="mb-4">
        <Card.Content>{form}</Card.Content>
      </Card>
    );
  }
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
