"use client";

import { useId, useState, useTransition } from "react";
import { ToggleButton, ToggleButtonGroup, toast, type useOverlayState } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { useClock } from "@/lib/hooks/use-clock";
import { KEY_PAUSE_HOURS, pauseEnd } from "@/lib/keys/pause";
import type { ActionFail } from "@/types/actions";
import type { KeyPauseInput, VirtualKeyView } from "@/types/keys";

export default function KeyPauseDialog({
  state,
  keyId,
  keyName,
  onPause,
  onPaused,
}: {
  state: ReturnType<typeof useOverlayState>;
  keyId: string | null;
  keyName: string;
  onPause: (input: KeyPauseInput) => Promise<{ key: VirtualKeyView } | ActionFail>;
  onPaused: (key: VirtualKeyView) => void;
}) {
  const t = useTranslations("Keys.pause");
  const tKeys = useTranslations("Keys");
  const showError = useErrorToast();
  const format = useFormatter();
  const now = useClock(60_000);
  const durationLabel = useId();
  const [hours, setHours] = useState<number>(KEY_PAUSE_HOURS[0]);
  const [pending, start] = useTransition();
  const until = pauseEnd(hours, now);

  function pause(close: () => void) {
    if (!keyId) return;
    start(async () => {
      const result = await onPause({ id: keyId, hours });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onPaused(result.key);
      toast(tKeys("toasts.paused"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("title", { name: keyName })}
      description={t("description")}
      submitLabel={t("submit")}
      pending={pending}
      isSubmitDisabled={!keyId}
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
            const next = KEY_PAUSE_HOURS.find((item) => String(item) === [...keys][0]);
            if (next !== undefined) setHours(next);
          }}
          isDisabled={pending}
        >
          {KEY_PAUSE_HOURS.map((item, index) => (
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
