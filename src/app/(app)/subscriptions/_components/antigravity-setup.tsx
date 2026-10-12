"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Description, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { saveAntigravityConfigAction } from "../_action";
import { isActionFail } from "@/lib/http/action-result";

export default function AntigravitySetup({
  configured,
  onChanged,
}: {
  configured: boolean | null;
  onChanged: (configured: boolean) => void;
}) {
  const t = useTranslations("Subscriptions.antigravity");
  const tError = useTranslations("Error");
  const [secret, setSecret] = useState("");
  const [pending, start] = useTransition();

  function save(value: string) {
    start(async () => {
      const result = await saveAntigravityConfigAction({ clientSecret: value });
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setSecret("");
      onChanged(result.configured);
      toast(t(result.configured ? "saved" : "removed"), { variant: "success" });
    });
  }

  return (
    <Card variant="secondary">
      <Card.Header>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Card.Title>{t("title")}</Card.Title>
          {configured === null ? null : (
            <Chip size="sm" variant="soft" color={configured ? "success" : "warning"}>
              {t("status", { configured: String(configured) })}
            </Chip>
          )}
        </div>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content>
        <TextField fullWidth type="password" value={secret} onChange={setSecret} isDisabled={pending}>
          <Label>{t("label")}</Label>
          <Input autoComplete="off" spellCheck={false} />
          <Description>{t("hint")}</Description>
        </TextField>
      </Card.Content>
      <Card.Footer className="flex flex-wrap items-center justify-end gap-2">
        {configured ? (
          <Button variant="tertiary" size="sm" isDisabled={pending} aria-label={t("remove")} onPress={() => save("")}>
            {t("remove")}
          </Button>
        ) : null}
        <Button
          size="sm"
          aria-label={t("save")}
          isPending={pending}
          isDisabled={!secret.trim()}
          onPress={() => save(secret)}
        >
          {({ isPending }) => (
            <>
              {isPending ? <Spinner color="current" size="sm" /> : null}
              {t("save")}
            </>
          )}
        </Button>
      </Card.Footer>
    </Card>
  );
}
