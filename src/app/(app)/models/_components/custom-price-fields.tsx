"use client";

import { FieldError, Label, NumberField } from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import { validPrice } from "@/lib/gateway/billing/price-schedule";
import type { PriceWindowDraft } from "@/types/models";
import PriceScheduleFields from "./price-schedule-fields";

function PriceField({
  label,
  value,
  isDisabled,
  onChange,
}: {
  label: string;
  value: number;
  isDisabled: boolean;
  onChange: (value: number) => void;
}) {
  const t = useTranslations("Models");
  return (
    <NumberField
      fullWidth
      value={value}
      onChange={onChange}
      minValue={0}
      formatOptions={formats.number.price}
      isInvalid={!validPrice(value)}
      isDisabled={isDisabled}
    >
      <Label>{label}</Label>
      <NumberField.Group>
        <NumberField.Input />
      </NumberField.Group>
      {validPrice(value) ? null : <FieldError>{t("priceInvalid")}</FieldError>}
    </NumberField>
  );
}

export default function CustomPriceFields({
  price,
  windows,
  timeZone,
  isDisabled,
  onPriceChange,
  onWindowsChange,
  onTimeZoneChange,
}: {
  price: { input: number; output: number };
  windows: PriceWindowDraft[];
  timeZone: string;
  isDisabled: boolean;
  onPriceChange: (price: { input: number; output: number }) => void;
  onWindowsChange: (windows: PriceWindowDraft[]) => void;
  onTimeZoneChange: (timeZone: string) => void;
}) {
  const t = useTranslations("Models");
  return (
    <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
      <PriceField
        label={t("fields.priceIn")}
        value={price.input}
        isDisabled={isDisabled}
        onChange={(input) => onPriceChange({ ...price, input })}
      />
      <PriceField
        label={t("fields.priceOut")}
        value={price.output}
        isDisabled={isDisabled}
        onChange={(output) => onPriceChange({ ...price, output })}
      />
      <p className="text-sm text-muted sm:col-span-2">{t("priceHint")}</p>
      <PriceScheduleFields
        windows={windows}
        timeZone={timeZone}
        basePrice={price}
        isDisabled={isDisabled}
        onWindowsChange={onWindowsChange}
        onTimeZoneChange={onTimeZoneChange}
      />
    </div>
  );
}
