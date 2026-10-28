"use client";

import { useTransition } from "react";
import { Alert, Button, Spinner, toast } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { isActionFail } from "@/lib/http/action-result";
import { useSecurityError } from "@/components/security/use-security-error";
import type { SecurityOverview } from "@/types/security";
import { restoreOwnCredentialsAction } from "../_action";

export default function CredentialsAlert({
  credentials,
  onChange,
}: {
  credentials: SecurityOverview["credentials"];
  onChange: (overview: SecurityOverview) => void;
}) {
  const t = useTranslations("Account.credentials");
  const format = useFormatter();
  const errorText = useSecurityError();
  const [restoring, startRestore] = useTransition();
  if (!credentials.suspendedAt) return null;

  return (
    <Alert status="warning">
      <Alert.Indicator />
      <Alert.Content className="min-w-0">
        <Alert.Title>{t("title")}</Alert.Title>
        <Alert.Description className="break-words">
          {t("body", {
            date: format.dateTime(new Date(credentials.suspendedAt), { dateStyle: "medium", timeStyle: "short" }),
            canRestore: credentials.canRestore ? "true" : "false",
          })}
        </Alert.Description>
        {credentials.canRestore ? (
          <div className="mt-2">
            <Button
              size="sm"
              variant="secondary"
              isPending={restoring}
              onPress={() =>
                startRestore(async () => {
                  const result = await restoreOwnCredentialsAction();
                  if (isActionFail(result)) {
                    toast.danger(errorText(result.error));
                    return;
                  }
                  onChange(result);
                  toast(t("restored"), { variant: "success" });
                })
              }
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : <KeyRound size={14} aria-hidden />}
                  {t("restore")}
                </>
              )}
            </Button>
          </div>
        ) : null}
      </Alert.Content>
    </Alert>
  );
}
