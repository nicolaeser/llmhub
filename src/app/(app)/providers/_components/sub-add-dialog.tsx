"use client";

import { useState, useTransition } from "react";
import {
  Checkbox,
  Description,
  Fieldset,
  Input,
  Label,
  ListBox,
  Select,
  Separator,
  TextField,
  toast,
  type useOverlayState,
} from "@heroui/react";
import { Link2 } from "lucide-react";
import { useTranslations } from "next-intl";
import FormDialog from "@/components/console/form-dialog";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { SUB_ADD_DEFAULT_DAYS, SUB_ADD_LABEL_MAX } from "@/schemas/sub-add";
import type { AccessMode, SignInKind } from "@/types/providers";
import type { SubAddCreated } from "@/types/sub-add";
import { createSubAddLinkAction } from "../_action";
import AccessFields, { pickedFrom, pickedTargets, useAssignmentOptions } from "./access-fields";

const DAY_OPTIONS = [1, 3, 7, 14, 30, 60, 90] as const;
const ACCOUNT_OPTIONS = [1, 2, 3, 5, 10, 20, 50, 0] as const;

export default function SubAddDialog({
  state,
  kinds,
  antigravityReady,
  onCreated,
}: {
  state: ReturnType<typeof useOverlayState>;
  kinds: SignInKind[];
  antigravityReady: boolean | null;
  onCreated: (result: SubAddCreated) => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tProviders = useTranslations("Providers");
  const showError = useErrorToast();
  const [label, setLabel] = useState("");
  const [selected, setSelected] = useState<SignInKind[]>(kinds);
  const [days, setDays] = useState<number>(SUB_ADD_DEFAULT_DAYS);
  const [accounts, setAccounts] = useState<number>(1);
  const [mode, setMode] = useState<AccessMode>("open");
  const [picked, setPicked] = useState(() => pickedFrom([]));
  const [pending, start] = useTransition();
  const options = useAssignmentOptions(state.isOpen && mode === "limited");

  function create(close: () => void) {
    start(async () => {
      const result = await createSubAddLinkAction({
        label,
        kinds: selected,
        days,
        maxAccounts: accounts === 0 ? null : accounts,
        restricted: mode === "limited",
        targets: mode === "limited" ? pickedTargets(picked) : [],
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onCreated(result);
      toast(t("createdToast"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      title={t("dialogTitle")}
      description={t("dialogDescription")}
      submitLabel={t("submit")}
      submitIcon={<Link2 size={16} aria-hidden />}
      pending={pending}
      isSubmitDisabled={!label.trim() || selected.length === 0 || (mode === "limited" && options === null)}
      onSubmit={create}
    >
      <TextField fullWidth value={label} onChange={setLabel} isDisabled={pending} maxLength={SUB_ADD_LABEL_MAX} isRequired>
        <Label>{t("label")}</Label>
        <Input autoComplete="off" />
        <Description>{t("labelHint")}</Description>
      </TextField>
      <Fieldset className="gap-2">
        <Fieldset.Legend>{t("providers")}</Fieldset.Legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {kinds.map((kind) => (
            <Checkbox
              key={kind}
              isSelected={selected.includes(kind)}
              isDisabled={pending}
              onChange={(checked) =>
                setSelected((current) => (checked ? [...current, kind] : current.filter((item) => item !== kind)))
              }
            >
              <Checkbox.Content>
                <Checkbox.Control>
                  <Checkbox.Indicator />
                </Checkbox.Control>
                <span className="text-sm">{tProviders("kindShort", { kind })}</span>
              </Checkbox.Content>
            </Checkbox>
          ))}
        </div>
        {antigravityReady === false && selected.includes("antigravity") ? (
          <p className="text-xs text-warning">{t("antigravityHidden")}</p>
        ) : null}
      </Fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <Select
          selectedKey={String(days)}
          onSelectionChange={(key) => setDays(Number(key))}
          isDisabled={pending}
          fullWidth
        >
          <Label>{t("validFor")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("validFor")}>
              {DAY_OPTIONS.map((option) => (
                <ListBox.Item key={option} id={String(option)} textValue={t("days", { days: option })}>
                  {t("days", { days: option })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
        <Select
          selectedKey={String(accounts)}
          onSelectionChange={(key) => setAccounts(Number(key))}
          isDisabled={pending}
          fullWidth
        >
          <Label>{t("maxAccounts")}</Label>
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("maxAccounts")}>
              {ACCOUNT_OPTIONS.map((option) => (
                <ListBox.Item key={option} id={String(option)} textValue={t("accountOption", { count: option })}>
                  {t("accountOption", { count: option })}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      <Separator />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">{t("accessTitle")}</p>
        <p className="text-sm text-muted">{t("accessHint")}</p>
      </div>
      <AccessFields
        mode={mode}
        onModeChange={setMode}
        picked={picked}
        onPickedChange={setPicked}
        options={options}
        known={[]}
        isDisabled={pending}
      />
    </FormDialog>
  );
}
