"use client";

import { Alert, Button, Card, FieldError, Label, NumberField, TimeField } from "@heroui/react";
import { parseTime } from "@internationalized/date";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { formats } from "@/i18n/formats";
import {
  clockMinute,
  MAX_PRICE_WINDOWS,
  minuteClock,
  scheduleOverlaps,
  validPrice,
} from "@/lib/gateway/price-schedule";
import type { PriceWindowDraft } from "@/types/models";

function clockValue(value: string) {
  return clockMinute(value) === null ? null : parseTime(value);
}

export default function PriceScheduleFields({
  windows,
  timeZone,
  basePrice,
  isDisabled,
  onWindowsChange,
  onTimeZoneChange,
}: {
  windows: PriceWindowDraft[];
  timeZone: string;
  basePrice: { input: number; output: number };
  isDisabled: boolean;
  onWindowsChange: (windows: PriceWindowDraft[]) => void;
  onTimeZoneChange: (timeZone: string) => void;
}) {
  const t = useTranslations("Models.schedule");
  const tModels = useTranslations("Models");

  function patch(key: number, change: Partial<PriceWindowDraft>) {
    onWindowsChange(windows.map((w) => (w.key === key ? { ...w, ...change } : w)));
  }

  function add() {
    onWindowsChange([
      ...windows,
      {
        key: Math.max(0, ...windows.map((w) => w.key)) + 1,
        start: "22:00",
        end: "06:00",
        priceInput: validPrice(basePrice.input) ? basePrice.input : 0,
        priceOutput: validPrice(basePrice.output) ? basePrice.output : 0,
      },
    ]);
  }

  return (
    <div className="space-y-3 sm:col-span-2">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("title")}</p>
        <p className="text-sm text-muted">{t("hint")}</p>
      </div>
      {windows.map((w, i) => {
        const start = clockMinute(w.start);
        const end = clockMinute(w.end);
        const sameTime = start !== null && start === end;
        return (
          <Card key={w.key} variant="secondary">
            <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
              <TimeField
                fullWidth
                value={clockValue(w.start)}
                onChange={(value) =>
                  patch(w.key, { start: value ? minuteClock(value.hour * 60 + value.minute) : "" })
                }
                isInvalid={start === null || sameTime}
                isDisabled={isDisabled}
              >
                <Label>{t("start")}</Label>
                <TimeField.Group>
                  <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                </TimeField.Group>
                {sameTime ? <FieldError>{t("sameTime")}</FieldError> : null}
              </TimeField>
              <TimeField
                fullWidth
                value={clockValue(w.end)}
                onChange={(value) =>
                  patch(w.key, { end: value ? minuteClock(value.hour * 60 + value.minute) : "" })
                }
                isInvalid={end === null || sameTime}
                isDisabled={isDisabled}
              >
                <Label>{t("end")}</Label>
                <TimeField.Group>
                  <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                </TimeField.Group>
              </TimeField>
              <NumberField
                fullWidth
                value={w.priceInput}
                onChange={(value) => patch(w.key, { priceInput: value })}
                minValue={0}
                formatOptions={formats.number.price}
                isInvalid={!validPrice(w.priceInput)}
                isDisabled={isDisabled}
              >
                <Label>{tModels("fields.priceIn")}</Label>
                <NumberField.Group>
                  <NumberField.Input />
                </NumberField.Group>
                {validPrice(w.priceInput) ? null : <FieldError>{tModels("priceInvalid")}</FieldError>}
              </NumberField>
              <NumberField
                fullWidth
                value={w.priceOutput}
                onChange={(value) => patch(w.key, { priceOutput: value })}
                minValue={0}
                formatOptions={formats.number.price}
                isInvalid={!validPrice(w.priceOutput)}
                isDisabled={isDisabled}
              >
                <Label>{tModels("fields.priceOut")}</Label>
                <NumberField.Group>
                  <NumberField.Input />
                </NumberField.Group>
                {validPrice(w.priceOutput) ? null : <FieldError>{tModels("priceInvalid")}</FieldError>}
              </NumberField>
            </div>
            <Button
              size="sm"
              variant="danger-soft"
              aria-label={t("remove", { index: i + 1 })}
              isDisabled={isDisabled}
              onPress={() => onWindowsChange(windows.filter((x) => x.key !== w.key))}
            >
              <Trash2 size={14} aria-hidden />
              {t("remove", { index: i + 1 })}
            </Button>
          </Card>
        );
      })}
      {scheduleOverlaps(windows) ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>{t("overlap")}</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : null}
      {windows.length ? (
        <TimeZonePicker
          label={t("timeZone")}
          description={t("timeZoneHint")}
          value={timeZone}
          isDisabled={isDisabled}
          onChange={onTimeZoneChange}
        />
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        isDisabled={isDisabled || windows.length >= MAX_PRICE_WINDOWS}
        onPress={add}
      >
        <Plus size={14} aria-hidden />
        {t("add")}
      </Button>
    </div>
  );
}
