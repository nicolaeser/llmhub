"use client";

import { useId } from "react";
import {
  Button,
  Card,
  Description,
  Label,
  Switch,
  TimeField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { parseTime } from "@internationalized/date";
import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import TimeZonePicker from "@/components/console/time-zone-picker";
import { MAX_ACCESS_WINDOWS } from "@/lib/gateway/key-restrictions";
import { clockMinute, minuteClock, WEEKDAYS } from "@/lib/gateway/price-schedule";
import type { AccessWindowDraft, Weekday } from "@/types/keys";

const MIDNIGHT = "00:00";
const WORK_DAYS: Weekday[] = ["mon", "tue", "wed", "thu", "fri"];
const WORK_HOURS = { start: "08:00", end: "18:00" };

function clockValue(value: string) {
  return clockMinute(value) === null ? null : parseTime(value);
}

function coversWholeDays(window: AccessWindowDraft): boolean {
  return window.start === MIDNIGHT && window.end === MIDNIGHT;
}

export default function AccessWindowFields({
  windows,
  timeZone,
  isDisabled,
  onWindowsChange,
  onTimeZoneChange,
}: {
  windows: AccessWindowDraft[];
  timeZone: string;
  isDisabled: boolean;
  onWindowsChange: (windows: AccessWindowDraft[]) => void;
  onTimeZoneChange: (timeZone: string) => void;
}) {
  const t = useTranslations("Keys.windows");
  const idPrefix = useId();

  function patch(key: number, change: Partial<AccessWindowDraft>) {
    onWindowsChange(windows.map((w) => (w.key === key ? { ...w, ...change } : w)));
  }

  function add() {
    onWindowsChange([
      ...windows,
      { key: Math.max(0, ...windows.map((w) => w.key)) + 1, days: WORK_DAYS, ...WORK_HOURS },
    ]);
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("title")}</p>
        <p className="text-sm text-muted">{t("hint")}</p>
      </div>
      {windows.map((w, i) => {
        const daysLabel = `${idPrefix}-days-${w.key}`;
        const wholeDays = coversWholeDays(w);
        const start = clockMinute(w.start);
        const end = clockMinute(w.end);
        const nextDay = start !== null && end !== null && end <= start;
        return (
          <Card key={w.key} variant="secondary">
            <div className="space-y-2">
              <p id={daysLabel} className="text-sm font-medium text-foreground">
                {t("days")}
              </p>
              <ToggleButtonGroup
                fullWidth
                isDetached
                size="sm"
                className="flex-wrap"
                selectionMode="multiple"
                disallowEmptySelection
                aria-labelledby={daysLabel}
                selectedKeys={w.days}
                onSelectionChange={(keys) => patch(w.key, { days: WEEKDAYS.filter((day) => keys.has(day)) })}
                isDisabled={isDisabled}
              >
                {WEEKDAYS.map((day) => (
                  <ToggleButton key={day} id={day} aria-label={t("dayName", { day })}>
                    {t("dayShort", { day })}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>
            <Switch
              isSelected={wholeDays}
              onChange={(on) => patch(w.key, on ? { start: MIDNIGHT, end: MIDNIGHT } : WORK_HOURS)}
              isDisabled={isDisabled}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>{t("allDay")}</Label>
              </Switch.Content>
            </Switch>
            {wholeDays ? null : (
              <div className="grid gap-3 sm:grid-cols-2 sm:items-start">
                <TimeField
                  fullWidth
                  value={clockValue(w.start)}
                  onChange={(value) =>
                    patch(w.key, { start: value ? minuteClock(value.hour * 60 + value.minute) : "" })
                  }
                  isInvalid={start === null}
                  isDisabled={isDisabled}
                >
                  <Label>{t("start")}</Label>
                  <TimeField.Group>
                    <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                  </TimeField.Group>
                </TimeField>
                <TimeField
                  fullWidth
                  value={clockValue(w.end)}
                  onChange={(value) =>
                    patch(w.key, { end: value ? minuteClock(value.hour * 60 + value.minute) : "" })
                  }
                  isInvalid={end === null}
                  isDisabled={isDisabled}
                >
                  <Label>{t("end")}</Label>
                  <TimeField.Group>
                    <TimeField.Input>{(segment) => <TimeField.Segment segment={segment} />}</TimeField.Input>
                  </TimeField.Group>
                  {nextDay ? <Description>{t("nextDay")}</Description> : null}
                </TimeField>
              </div>
            )}
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
        isDisabled={isDisabled || windows.length >= MAX_ACCESS_WINDOWS}
        onPress={add}
      >
        <Plus size={14} aria-hidden />
        {t("add")}
      </Button>
    </div>
  );
}
