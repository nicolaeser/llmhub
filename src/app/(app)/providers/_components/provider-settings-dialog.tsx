"use client";

import { Button, Modal, Separator, type useOverlayState } from "@heroui/react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { kindIcon } from "@/components/providers/kind-icons";
import { DEFAULT_ACCOUNT_STRATEGY } from "@/lib/gateway/routing/account-access";
import { autoResetPolicy, isResetKind } from "@/lib/gateway/routing/auto-reset-policy";
import { startsWindows } from "@/lib/gateway/upstreams/provider-kinds";
import type {
  AccountRouting,
  AntigravityClientState,
  KickoffModels,
  SignInKind,
  WindowKickoffs,
} from "@/types/providers";
import type { AutoResetPolicies } from "@/types/resets";
import AccountRoutingPicker from "./account-routing-picker";
import AntigravitySetup from "./antigravity-setup";
import AutoResetSettings from "./auto-reset-settings";
import WindowKickoffSettings from "./window-kickoff-settings";

export default function ProviderSettingsDialog({
  state,
  kind,
  accounts,
  routing,
  autoReset,
  kickoff,
  kickoffModels,
  antigravity,
  onRouting,
  onAutoReset,
  onKickoff,
  onAntigravity,
}: {
  state: ReturnType<typeof useOverlayState>;
  kind: SignInKind | null;
  accounts: number;
  routing: AccountRouting;
  autoReset: AutoResetPolicies;
  kickoff: WindowKickoffs;
  kickoffModels: KickoffModels;
  antigravity: AntigravityClientState | null;
  onRouting: (routing: AccountRouting) => void;
  onAutoReset: (policies: AutoResetPolicies) => void;
  onKickoff: (kickoff: WindowKickoffs) => void;
  onAntigravity: (state: AntigravityClientState) => void;
}) {
  const t = useTranslations("Subscriptions.settings");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");

  return (
    <Modal.Backdrop isOpen={state.isOpen} onOpenChange={state.setOpen}>
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
                        onSaved={onAutoReset}
                      />
                    </>
                  ) : null}
                  {accounts > 0 && startsWindows(kind) ? (
                    <>
                      <Separator />
                      <WindowKickoffSettings
                        kind={kind}
                        model={kickoff[kind] ?? ""}
                        models={kickoffModels[kind] ?? []}
                        onSaved={onKickoff}
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
  );
}
