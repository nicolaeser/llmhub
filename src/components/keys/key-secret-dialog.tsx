"use client";

import { Alert, Button, Card, Modal, type useOverlayState } from "@heroui/react";
import { ArrowRight, KeyRound } from "lucide-react";
import { useTranslations } from "next-intl";
import CopyButton from "@/components/console/copy-button";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";
import { API_PREFIX } from "@/lib/gateway/api-paths";
import { useOrigin } from "@/lib/hooks/use-origin";

export type IssuedSecret = { id: string; name: string; value: string; rotated: boolean };

function curlSnippet(baseUrl: string, secret: string) {
  return [`curl ${baseUrl}/models \\`, `  -H "Authorization: Bearer ${secret}"`].join("\n");
}

export default function KeySecretDialog({
  state,
  secret,
  linkToDetail,
}: {
  state: ReturnType<typeof useOverlayState>;
  secret: IssuedSecret | null;
  linkToDetail: boolean;
}) {
  const t = useTranslations("Keys.secret");
  const origin = useOrigin();
  const baseUrl = `${origin}${API_PREFIX}/v1`;
  const snippet = secret ? curlSnippet(baseUrl, secret.value) : "";
  const rotated = secret?.rotated ? "yes" : "no";

  return (
    <Modal.Backdrop variant="blur" isDismissable={false} isOpen={state.isOpen} onOpenChange={state.setOpen}>
      <Modal.Container>
        <Modal.Dialog className="max-w-2xl">
          {({ close }) => (
            <>
              <Modal.Header className="flex-row items-center gap-3">
                <IconTile icon={KeyRound} tone="success" />
                <div className="min-w-0 space-y-1">
                  <Modal.Heading className="break-words">{t("title", { name: secret?.name ?? "", rotated })}</Modal.Heading>
                  <p className="text-sm text-muted">{t("subtitle", { rotated })}</p>
                </div>
              </Modal.Header>
              <Modal.Body className="space-y-4">
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>{t("onceTitle")}</Alert.Title>
                    <Alert.Description>{t("onceHint")}</Alert.Description>
                  </Alert.Content>
                </Alert>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{t("keyLabel")}</p>
                  <Card variant="secondary" className="flex-row flex-wrap items-center justify-between gap-3">
                    <code className="min-w-0 flex-1 basis-60 font-mono text-sm break-all text-foreground">
                      {secret?.value}
                    </code>
                    <CopyButton text={secret?.value ?? ""} label={t("copyKey")} variant="secondary" showLabel />
                  </Card>
                </div>
                <div className="space-y-2">
                  <p className="text-sm font-medium text-foreground">{t("baseUrl")}</p>
                  <Card variant="secondary" className="flex-row items-center justify-between gap-3">
                    <code className="min-w-0 font-mono text-sm break-all text-foreground">{baseUrl}</code>
                    <CopyButton text={baseUrl} label={t("copyBaseUrl")} />
                  </Card>
                  <p className="text-xs text-muted">{t("baseUrlHint")}</p>
                </div>
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">{t("tryIt")}</p>
                      <p className="text-xs text-muted">{t("tryItHint")}</p>
                    </div>
                    <CopyButton text={snippet} label={t("copySnippet")} />
                  </div>
                  <Card variant="secondary">
                    <pre className="font-mono text-xs break-all whitespace-pre-wrap text-foreground">{snippet}</pre>
                  </Card>
                </div>
              </Modal.Body>
              <Modal.Footer className="flex-wrap gap-2">
                {linkToDetail && secret ? (
                  <Link
                    href={`/keys/${secret.id}`}
                    className="inline-flex items-center gap-1 text-sm font-medium text-accent"
                    onClick={close}
                  >
                    {t("open")}
                    <ArrowRight size={14} aria-hidden />
                  </Link>
                ) : null}
                <Button onPress={close}>{t("done")}</Button>
              </Modal.Footer>
            </>
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
