"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Description, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import type { AntigravityClientState } from "@/types/providers";
import { saveAntigravityConfigAction } from "../_action";

export default function AntigravitySetup({
  state,
  onChanged,
}: {
  state: AntigravityClientState | null;
  onChanged: (state: AntigravityClientState) => void;
}) {
  const t = useTranslations("Subscriptions.antigravity");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [pending, start] = useTransition();

  if (state === null || (state.bundled && !state.saved)) return null;
  const { saved, bundled } = state;
  const editing = !saved || replacing;

  function save(value: string) {
    start(async () => {
      const result = await saveAntigravityConfigAction({ clientSecret: value });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setSecret("");
      setReplacing(false);
      onChanged(result);
      toast(result.saved ? t("saved") : t("removed", { bundled: String(result.bundled) }), { variant: "success" });
    });
  }

  return (
    <Card variant="secondary">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description", { bundled: String(bundled) })}</Card.Description>
        </div>
        <Chip size="sm" variant="soft" color={saved ? "success" : "warning"} className="whitespace-nowrap">
          {t("status", { configured: String(saved) })}
        </Chip>
      </Card.Header>
      {editing ? (
        <Card.Content>
          <TextField fullWidth type="password" value={secret} onChange={setSecret} isDisabled={pending}>
            <Label>{t("label")}</Label>
            <Input autoComplete="off" spellCheck={false} />
            <Description>{t("hint", { bundled: String(bundled) })}</Description>
          </TextField>
        </Card.Content>
      ) : null}
      <Card.Footer className="flex-wrap items-center justify-end gap-2">
        {editing ? (
          <>
            {replacing ? (
              <Button variant="tertiary" size="sm" isDisabled={pending} onPress={() => setReplacing(false)}>
                {tCommon("cancel")}
              </Button>
            ) : null}
            <Button size="sm" isPending={pending} isDisabled={!secret.trim()} onPress={() => save(secret)}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("save")}
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            <Button variant="tertiary" size="sm" isPending={pending} onPress={() => save("")}>
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("remove")}
                </>
              )}
            </Button>
            <Button variant="secondary" size="sm" isDisabled={pending} onPress={() => setReplacing(true)}>
              {t("replace")}
            </Button>
          </>
        )}
      </Card.Footer>
    </Card>
  );
}
