"use client";

import { use, useState } from "react";
import { Alert, Card } from "@heroui/react";
import { useFormatter, useTranslations } from "next-intl";
import { LoadError, PageLoading } from "@/components/console/page-status";
import SignInPanel from "@/components/providers/sign-in-panel";
import { useActionData } from "@/lib/hooks/use-action-data";
import { subAddManagePath } from "@/lib/http/public-path";
import type { SignInFlowActions, SignInKind } from "@/types/providers";
import type { SubAddDone, SubAddOffer } from "@/types/sub-add";
import {
  completeSubAddSignInAction,
  openSubAddLinkAction,
  pollSubAddSignInAction,
  startSubAddSignInAction,
} from "./_action";
import AddedAccounts from "./_components/added-accounts";
import KindPicker from "./_components/kind-picker";
import ShareNotice from "./_components/share-notice";

export default function SubAddPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const t = useTranslations("SubAdd");
  const format = useFormatter();
  const page = useActionData<SubAddOffer>(() => openSubAddLinkAction({ token }));
  const offer = page.data;
  const [picked, setPicked] = useState<SignInKind | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [added, setAdded] = useState<SubAddDone[]>([]);
  const [manage, setManage] = useState<{ token: string; url: string } | null>(null);
  const [adding, setAdding] = useState(true);
  const [round, setRound] = useState(0);
  const kind = picked ?? offer?.kinds[0] ?? null;
  const owner = manage ? { manage: manage.token } : {};

  const actions: SignInFlowActions<SubAddDone> = {
    start: (next) => startSubAddSignInAction({ token, kind: next }),
    poll: (input) => pollSubAddSignInAction({ token, ...input, ...owner }),
    complete: (input) => completeSubAddSignInAction({ token, ...input, ...owner }),
  };

  function signedIn(result: SubAddDone) {
    setAdded((cur) => [...cur, result]);
    setManage({
      token: result.manageToken,
      url: new URL(subAddManagePath(result.manageToken), window.location.origin).toString(),
    });
    setAdding(false);
    if (result.outcome === "created") {
      page.setData((cur) => ({ ...cur, remaining: cur.remaining === null ? null : Math.max(0, cur.remaining - 1) }));
    }
  }

  function addAnother() {
    setRound((n) => n + 1);
    setAdding(true);
  }

  if (!offer) {
    if (page.error === null) return <PageLoading />;
    return (
      <div className="space-y-4">
        <h1 className="text-3xl font-semibold tracking-tight">{t("unavailableTitle")}</h1>
        {page.error === "SUB_ADD_UNAVAILABLE" ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("unavailable")}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <LoadError state={page} />
        )}
      </div>
    );
  }

  const canAddMore = offer.remaining === null || offer.remaining > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{t("title")}</h1>
        <p className="text-sm text-muted">
          {t("intro", { named: offer.instance ? "true" : "false", instance: offer.instance })}
        </p>
        <p className="text-sm break-words text-foreground">{t("label", { label: offer.label })}</p>
        <p className="text-xs text-muted">
          {t("limits", {
            limited: offer.remaining === null ? "false" : "true",
            remaining: offer.remaining ?? 0,
            date: format.dateTime(new Date(offer.expiresAt), { dateStyle: "medium", timeStyle: "short" }),
          })}
        </p>
      </div>

      {manage && added.length ? (
        <AddedAccounts
          added={added}
          manageUrl={manage.url}
          manageToken={manage.token}
          canAddMore={canAddMore && !adding}
          onAddAnother={addAnother}
        />
      ) : null}

      {adding && canAddMore ? (
        <>
          <ShareNotice instance={offer.instance} accepted={accepted} onAcceptedChange={setAccepted} />
          <Card className="gap-5">
            <Card.Header>
              <Card.Title>{t("pickTitle")}</Card.Title>
              <Card.Description>{t("pickHint")}</Card.Description>
            </Card.Header>
            <Card.Content className="gap-5">
              <KindPicker kinds={offer.kinds} value={kind} isDisabled={false} onChange={setPicked} />
              {kind ? (
                <SignInPanel
                  key={`${kind}-${round}`}
                  kind={kind}
                  current={null}
                  isDisabled={!accepted}
                  actions={actions}
                  hint={t("signInHint", { kind })}
                  onSignedIn={signedIn}
                />
              ) : null}
            </Card.Content>
          </Card>
        </>
      ) : null}
    </div>
  );
}
