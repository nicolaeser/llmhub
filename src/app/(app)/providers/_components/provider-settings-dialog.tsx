"use client";

import { Button, Modal, Separator, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { kindIcon } from "@/components/providers/kind-icons";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import type { AccountRouting, AntigravityClientState, SignInKind } from "@/types/providers";
import type { AutoResetPolicies } from "@/types/resets";
import AccountRoutingPicker from "./account-routing-picker";
import AntigravitySetup from "./antigravity-setup";
import AutoResetSettings from "./auto-reset-settings";

export default function ProviderSettingsDialog({
  state,
  kind,
  accounts,
  routing,
  autoReset,
  canManage,
  antigravity,
  onRouting,
  onAutoReset,
  onAntigravity,
}: {
  state: ReturnType<typeof useOverlayState>;
  kind: SignInKind | null;
  accounts: number;
  routing: AccountRouting;
  autoReset: AutoResetPolicies;
  canManage: boolean;
  antigravity: AntigravityClientState | null;
  onRouting: (routing: AccountRouting) => void;
  onAutoReset: (policies: AutoResetPolicies) => void;
  onAntigravity: (state: AntigravityClientState) => void;
}) {
  const t = useTranslations("Subscriptions.settings");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-4xl">
            {({ close }) =>
              kind ? (
                <>
                  <Modal.Header className="flex-row items-start gap-3">
                    <IconTile icon={kindIcon(kind)} />
                    <div className="min-w-0 flex-1">
                      <Modal.Heading>{t("title", { provider: tProviders("kindShort", { kind }) })}</Modal.Heading>
                      <p className="text-sm text-muted">{t("description")}</p>
                    </div>
                  </Modal.Header>
                  <Modal.Body className="space-y-6">
                    {kind === "antigravity" ? (
                      <AntigravitySetup state={antigravity} onChanged={onAntigravity} />
                    ) : null}
                    {accounts > 0 ? (
                      <AccountRoutingPicker
                        kind={kind}
                        strategy={routing[kind] ?? DEFAULT_ACCOUNT_STRATEGY}
                        accounts={accounts}
                        onSaved={onRouting}
                      />
                    ) : null}
                    {accounts > 0 && isResetKind(kind) ? (
                      <>
                        <Separator />
                        <AutoResetSettings
                          kind={kind}
                          policy={autoReset[kind] ?? autoResetPolicy({})}
                          canManage={canManage}
                          onSaved={onAutoReset}
                        />
                      </>
                    ) : null}
                  </Modal.Body>
                  <Modal.Footer>
                    <Button variant="secondary" onPress={close}>
                      {tCommon("done")}
                    </Button>
                  </Modal.Footer>
                </>
              ) : null
            }
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
