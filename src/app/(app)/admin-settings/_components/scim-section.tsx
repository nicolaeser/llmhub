"use client";

import { useState } from "react";
import { Alert, Button, Surface, toast, useOverlayState } from "@heroui/react";
import { Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { issueScimTokenAction, revokeScimTokenAction } from "../_action";
import { SettingSection } from "./fields";
import { isActionFail } from "@/lib/http/action-result";
import { useOrigin } from "@/lib/hooks/use-origin";

export function ScimSection({
  initiallySet,
  canManage,
}: {
  initiallySet: boolean;
  canManage: boolean;
}) {
  const t = useTranslations("AdminSettings");
  const tSecurity = useTranslations("Security");
  const origin = useOrigin();
  const [tokenSet, setTokenSet] = useState(initiallySet);
  const [token, setToken] = useState<string | null>(null);
  const issueStepUp = useOverlayState();
  const revokeStepUp = useOverlayState();
  const set = tokenSet ? "true" : "false";

  return (
    <SettingSection title={t("scim.title")} subtitle={t("scim.subtitle")}>
      <ul className="divide-y divide-border">
        <li className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
          <span className="text-muted">{t("scim.endpoint")}</span>
          <code className="min-w-0 font-mono text-xs break-all">{`${origin}/scim/v2`}</code>
        </li>
        <li className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
          <span className="text-muted">{t("scim.token")}</span>
          <span className={tokenSet ? "text-success" : "text-muted"}>{t("scim.state", { set })}</span>
        </li>
      </ul>
      {token ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content className="min-w-0">
            <Alert.Title>{t("scim.tokenTitle")}</Alert.Title>
            <Alert.Description>{t("scim.tokenHint")}</Alert.Description>
            <div className="mt-2 flex min-w-0 items-start gap-2">
              <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                <code className="font-mono text-sm break-all">{token}</code>
              </Surface>
              <Button
                isIconOnly
                size="sm"
                variant="secondary"
                aria-label={t("scim.copy")}
                onPress={async () => {
                  try {
                    await navigator.clipboard.writeText(token);
                    toast(tSecurity("copied"), { variant: "success" });
                  } catch {
                    toast.danger(tSecurity("copyFailed"));
                  }
                }}
              >
                <Copy size={14} aria-hidden />
              </Button>
            </div>
          </Alert.Content>
        </Alert>
      ) : null}
      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onPress={issueStepUp.open}>
            {t("scim.issue", { set })}
          </Button>
          {tokenSet ? (
            <Button size="sm" variant="danger-soft" onPress={revokeStepUp.open}>
              {t("scim.revoke")}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted">{t("scim.manageHint")}</p>
      )}
      <StepUpDialog
        state={issueStepUp}
        title={t("scim.issue", { set })}
        description={t("scim.issueDescription", { set })}
        confirmLabel={t("scim.issue", { set })}
        onConfirm={async (code) => {
          const result = await issueScimTokenAction({ code });
          if (isActionFail(result)) return result.error;
          setToken(result.scimToken);
          setTokenSet(true);
          toast(t("scim.issued"), { variant: "success" });
          return null;
        }}
      />
      <StepUpDialog
        state={revokeStepUp}
        danger
        title={t("scim.revoke")}
        description={t("scim.revokeDescription")}
        confirmLabel={t("scim.revoke")}
        onConfirm={async (code) => {
          const result = await revokeScimTokenAction({ code });
          if (isActionFail(result)) return result.error;
          setToken(null);
          setTokenSet(false);
          toast(t("scim.revoked"), { variant: "success" });
          return null;
        }}
      />
    </SettingSection>
  );
}
