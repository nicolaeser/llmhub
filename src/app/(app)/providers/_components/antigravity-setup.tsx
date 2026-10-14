"use client";

import { useState, useTransition } from "react";
import { Badge, Button, Card, Description, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isActionFail } from "@/lib/http/action-result";
import { saveAntigravityConfigAction } from "../_action";

export default function AntigravitySetup({
  configured,
  onChanged,
}: {
  configured: boolean | null;
  onChanged: (configured: boolean) => void;
}) {
  const t = useTranslations("Subscriptions.antigravity");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [pending, start] = useTransition();

  if (configured === null) return null;
  const editing = !configured || replacing;

  function save(value: string) {
    start(async () => {
      const result = await saveAntigravityConfigAction({ clientSecret: value });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setSecret("");
      setReplacing(false);
      onChanged(result.configured);
      toast(t(result.configured ? "saved" : "removed"), { variant: "success" });
    });
  }

  return (
    <Card variant="secondary">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Card.Title>{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </div>
        <Badge
          size="sm"
          variant="soft"
          color={configured ? "success" : "warning"}
          className="px-1.5 whitespace-nowrap"
        >
          {t("status", { configured: String(configured) })}
        </Badge>
      </Card.Header>
      {editing ? (
        <Card.Content>
          <TextField fullWidth type="password" value={secret} onChange={setSecret} isDisabled={pending}>
            <Label>{t("label")}</Label>
            <Input autoComplete="off" spellCheck={false} />
            <Description>{t("hint")}</Description>
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
