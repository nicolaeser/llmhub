"use client";

import { useId, useState, useTransition } from "react";
import { ToggleButton, ToggleButtonGroup, type useOverlayState } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useClock } from "@/lib/hooks/use-clock";
import { PAUSE_HOURS, pauseEnd } from "@/lib/keys/pause";

export default function PauseDialog({
  state,
  title,
  description,
  submitLabel,
  isSubmitDisabled = false,
  onPause,
}: {
  state: ReturnType<typeof useOverlayState>;
  title: string;
  description: string;
  submitLabel: string;
  isSubmitDisabled?: boolean;
  onPause: (hours: number) => Promise<boolean>;
}) {
  const t = useTranslations("Common.pause");
  const format = useFormatter();
  const now = useClock(60_000);
  const durationLabel = useId();
  const [hours, setHours] = useState<number>(PAUSE_HOURS[0]);
  const [pending, start] = useTransition();
  const until = pauseEnd(hours, now);

  function pause(close: () => void) {
    start(async () => {
      if (await onPause(hours)) close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={title}
      description={description}
      submitLabel={submitLabel}
      pending={pending}
      isSubmitDisabled={isSubmitDisabled}
      onSubmit={pause}
    >
      <div className="space-y-2">
        <p id={durationLabel} className="text-sm font-medium">
          {t("duration")}
        </p>
        <ToggleButtonGroup
          fullWidth
          selectionMode="single"
          disallowEmptySelection
          aria-labelledby={durationLabel}
          selectedKeys={[String(hours)]}
          onSelectionChange={(keys) => {
            const next = PAUSE_HOURS.find((item) => String(item) === [...keys][0]);
            if (next !== undefined) setHours(next);
          }}
          isDisabled={pending}
        >
          {PAUSE_HOURS.map((item, index) => (
            <ToggleButton key={item} id={String(item)}>
              {index > 0 ? <ToggleButtonGroup.Separator /> : null}
              {t("hours", { hours: item })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <p className="text-xs text-muted">
          {t("until", { timed: until ? "yes" : "no", until: until ? format.dateTime(until, "stamp") : "" })}
        </p>
      </div>
    </FormDialog>
  );
}
