"use client";

import { useState, useTransition } from "react";
import { toast, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import AccessWindowFields from "@/components/keys/access-window-fields";
import {
  BindingFields,
  EndpointsField,
  IpAllowlistField,
  KeyNameField,
  KeySwitchField,
  ModelAccessFields,
  RateLimitFields,
} from "@/components/keys/key-fields";
import { isActionFail } from "@/lib/http/action-result";
import {
  draftAccessValid,
  draftBasicsValid,
  draftNetworkValid,
  draftOfKey,
  draftScheduleValid,
  keyFieldsOf,
} from "@/lib/keys/draft";
import type { KeyDraft, KeyOptions, KeySection, VirtualKeyView } from "@/types/keys";
import { updateKeyAction } from "../../_action";

const SIZES = {
  basics: "lg",
  access: "lg",
  limits: "md",
  network: "md",
  schedule: "lg",
  content: "md",
} as const satisfies Record<KeySection, "md" | "lg">;

function sectionValid(section: KeySection, draft: KeyDraft): boolean {
  if (section === "basics") return draftBasicsValid(draft);
  if (section === "access") return draftAccessValid(draft);
  if (section === "network") return draftNetworkValid(draft);
  if (section === "schedule") return draftScheduleValid(draft);
  return true;
}

export default function KeySectionDialog({
  state,
  section,
  keyView,
  options,
  canBind,
  onSaved,
}: {
  state: ReturnType<typeof useOverlayState>;
  section: KeySection;
  keyView: VirtualKeyView;
  options: KeyOptions;
  canBind: boolean;
  onSaved: (key: VirtualKeyView) => void;
}) {
  const t = useTranslations("Keys");
  const showError = useErrorToast();
  const [draft, setDraft] = useState<KeyDraft>(() => draftOfKey(keyView));
  const [pending, start] = useTransition();
  const change = (patch: Partial<KeyDraft>) => setDraft((current) => ({ ...current, ...patch }));

  function save(close: () => void) {
    start(async () => {
      const result = await updateKeyAction({ ...keyFieldsOf(draft), id: keyView.token_id, blocked: draft.blocked });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onSaved(result.key);
      toast(t("toasts.saved", { mode: "updated" }), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size={SIZES[section]}
      title={t("section.title", { section })}
      description={t("section.hint", { section })}
      submitLabel={t("dialogSubmit", { mode: "edit" })}
      pending={pending}
      isSubmitDisabled={!sectionValid(section, draft)}
      onSubmit={save}
    >
      {section === "basics" ? (
        <>
          <KeyNameField value={draft.alias} onChange={(alias) => change({ alias })} isDisabled={pending} />
          <BindingFields draft={draft} options={options} canBind={canBind} isDisabled={pending} onChange={change} />
        </>
      ) : null}
      {section === "access" ? (
        <ModelAccessFields draft={draft} options={options} isDisabled={pending} onChange={change} />
      ) : null}
      {section === "limits" ? <RateLimitFields draft={draft} isDisabled={pending} onChange={change} /> : null}
      {section === "network" ? (
        <>
          <IpAllowlistField value={draft.ips} isDisabled={pending} onChange={(ips) => change({ ips })} />
          <EndpointsField draft={draft} isDisabled={pending} onChange={change} />
        </>
      ) : null}
      {section === "schedule" ? (
        <AccessWindowFields
          windows={draft.windows}
          timeZone={draft.timeZone}
          isDisabled={pending}
          showIntro={false}
          onWindowsChange={(windows) => change({ windows })}
          onTimeZoneChange={(timeZone) => change({ timeZone })}
        />
      ) : null}
      {section === "content" ? (
        <KeySwitchField
          label={t("fields.logContent")}
          description={t("fields.logContentHint")}
          isSelected={draft.logContent}
          isDisabled={pending}
          onChange={(logContent) => change({ logContent })}
        />
      ) : null}
    </FormDialog>
  );
}
