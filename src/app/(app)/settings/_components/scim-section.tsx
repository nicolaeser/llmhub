"use client";

import { useState } from "react";
import { Alert, Button, Chip, Surface, toast, useOverlayState } from "@heroui/react";
import { UsersRound } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import { StepUpDialog } from "@/components/security/step-up-dialog";
import { issueScimTokenAction, revokeScimTokenAction } from "../_action";
import IconTile from "@/components/console/icon-tile";
import { SettingSection } from "./setting-fields";
import { isActionFail } from "@/lib/http/action-result";

export default function ScimSection({
  initiallySet,
  canManage,
  groups,
  baseUrl,
}: {
  initiallySet: boolean;
  canManage: boolean;
  groups: number;
  baseUrl: string;
}) {
  const t = useTranslations("Settings.signIn");
  const [tokenSet, setTokenSet] = useState(initiallySet);
  const [token, setToken] = useState<string | null>(null);
  const issueStepUp = useOverlayState();
  const revokeStepUp = useOverlayState();
  const set = tokenSet ? "true" : "false";

  return (
    <SettingSection title={t("scim.title")} subtitle={t("scim.subtitle")}>
      <div className="flex items-start gap-3">
        <IconTile icon={UsersRound} tone={tokenSet ? "success" : "neutral"} />
        <ul className="min-w-0 flex-1 divide-y divide-border">
          <li className="flex flex-wrap items-center justify-between gap-2 pb-3 text-sm">
            <span className="text-muted">{t("scim.endpoint")}</span>
            <span className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 font-mono text-xs break-all">{baseUrl}</code>
              <CopyButton text={baseUrl} label={t("scim.copyEndpoint")} />
            </span>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <span className="text-muted">{t("scim.token")}</span>
            <Chip size="sm" variant="soft" color={tokenSet ? "success" : "default"}>
              {t("scim.state", { set })}
            </Chip>
          </li>
          <li className="flex flex-wrap items-center justify-between gap-2 pt-3 text-sm">
            <span className="text-muted">{t("scim.groups")}</span>
            <Chip size="sm" variant="soft">
              {t("scim.groupCount", { count: groups })}
            </Chip>
          </li>
        </ul>
      </div>
      <p className="text-xs text-muted">{t("scim.mappingHint")}</p>
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
              <CopyButton text={token} label={t("scim.copy")} variant="secondary" />
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
