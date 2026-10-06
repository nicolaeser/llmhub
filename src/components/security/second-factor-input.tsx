"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import {
  Button,
  Description,
  Input,
  InputOTP,
  Label,
  REGEXP_ONLY_DIGITS,
  TextField,
} from "@heroui/react";
import type { SecondFactorProof } from "@/types/security";

export const emptySecondFactor: SecondFactorProof = { method: "totp", code: "" };

export function secondFactorComplete(value: SecondFactorProof) {
  return value.method === "totp"
    ? /^\d{6}$/.test(value.code)
    : /^[0-9a-f]{16}$/i.test(value.code.replace(/[\s-]/g, ""));
}

export function SecondFactorInput({
  value,
  onChange,
  onComplete,
  isDisabled = false,
  isInvalid = false,
  autoFocus = false,
  allowRecovery = true,
  label,
}: {
  value: SecondFactorProof;
  onChange: (value: SecondFactorProof) => void;
  onComplete?: (code: string) => void;
  isDisabled?: boolean;
  isInvalid?: boolean;
  autoFocus?: boolean;
  allowRecovery?: boolean;
  label?: string;
}) {
  const t = useTranslations("Security");
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {value.method === "totp" ? (
        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor={id}>
            {label ?? t("codeLabel")}
          </Label>
          <InputOTP
            id={id}
            maxLength={6}
            pattern={REGEXP_ONLY_DIGITS}
            inputMode="numeric"
            autoComplete="one-time-code"
            value={value.code}
            onChange={(code: string) => onChange({ method: "totp", code })}
            onComplete={(code: string) => onComplete?.(code)}
            isDisabled={isDisabled}
            isInvalid={isInvalid}
            autoFocus={autoFocus}
          >
            <InputOTP.Group>
              <InputOTP.Slot index={0} />
              <InputOTP.Slot index={1} />
              <InputOTP.Slot index={2} />
            </InputOTP.Group>
            <InputOTP.Separator />
            <InputOTP.Group>
              <InputOTP.Slot index={3} />
              <InputOTP.Slot index={4} />
              <InputOTP.Slot index={5} />
            </InputOTP.Group>
          </InputOTP>
          <p className="text-xs text-muted">{t("codeHint")}</p>
        </div>
      ) : (
        <TextField fullWidth
          value={value.code}
          onChange={(code) => onChange({ method: "recovery", code })}
          isDisabled={isDisabled}
          isInvalid={isInvalid}
          autoFocus={autoFocus}
          className="min-w-0"
        >
          <Label>{t("recoveryCodeLabel")}</Label>
          <Input
            className="font-mono"
            placeholder="xxxxxxxx-xxxxxxxx"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
          />
          <Description>{t("recoveryCodeHint")}</Description>
        </TextField>
      )}
      {allowRecovery ? (
        <Button
          size="sm"
          variant="ghost"
          className="w-fit"
          isDisabled={isDisabled}
          onPress={() =>
            onChange({ method: value.method === "totp" ? "recovery" : "totp", code: "" })
          }
        >
          {t("switchMethod", { method: value.method })}
        </Button>
      ) : null}
    </div>
  );
}
