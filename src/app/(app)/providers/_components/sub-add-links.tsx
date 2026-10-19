"use client";

import { useState, useTransition } from "react";
import { Alert, Button, Card, Chip, Spinner, Surface, toast, useOverlayState } from "@heroui/react";
import { Link2, Link2Off } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import CopyButton from "@/components/console/copy-button";
import { LoadError } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { subAddStatus } from "@/lib/providers/sub-add-status";
import type { SubAddCreated, SubAddLinksPayload, SubAddLinkView, SubAddStatus } from "@/types/sub-add";
import { loadSubAddLinksAction, revokeSubAddLinkAction } from "../_action";
import SubAddDialog from "./sub-add-dialog";

const STATUS_COLOR = {
  active: "success",
  used_up: "warning",
  expired: "default",
  revoked: "danger",
} as const satisfies Record<SubAddStatus, "success" | "warning" | "default" | "danger">;

function LinkRow({
  link,
  now,
  canManage,
  onRevoked,
}: {
  link: SubAddLinkView;
  now: Date;
  canManage: boolean;
  onRevoked: (link: SubAddLinkView) => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const [revoking, startRevoke] = useTransition();
  const status = subAddStatus(link, now.getTime());
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: "medium", timeStyle: "short" });
  const kinds = format.list(
    link.kinds.map((kind) => tProviders("kindShort", { kind })),
    { type: "conjunction" },
  );

  function revoke() {
    startRevoke(async () => {
      const result = await revokeSubAddLinkAction(link.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onRevoked(result.link);
      toast(t("revoked", { label: link.label }), { variant: "success" });
    });
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium break-words text-foreground">{link.label}</p>
          <p className="text-xs text-muted">
            {t("createdBy", { named: link.createdBy ? "true" : "false", name: link.createdBy, date: date(link.createdAt) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} className="whitespace-nowrap">
            {t("status", { status })}
          </Chip>
          <Chip size="sm" variant="soft" className="whitespace-nowrap">
            {t("uses", {
              limited: link.maxAccounts === null ? "false" : "true",
              added: link.added,
              max: link.maxAccounts ?? 0,
            })}
          </Chip>
          {canManage && (status === "active" || status === "used_up") ? (
            <ConfirmDialog
              title={t("revokeTitle", { label: link.label })}
              description={t("revokeDescription")}
              confirmLabel={t("revoke")}
              cancelLabel={tCommon("cancel")}
              pending={revoking}
              onConfirm={revoke}
            >
              <Button size="sm" variant="tertiary" isPending={revoking} aria-label={t("revokeLabel", { label: link.label })}>
                {({ isPending }) => (
                  <>
                    {isPending ? <Spinner color="current" size="sm" /> : <Link2Off size={14} aria-hidden />}
                    {t("revoke")}
                  </>
                )}
              </Button>
            </ConfirmDialog>
          ) : null}
        </div>
      </div>
      <ul className="space-y-0.5 text-xs text-muted">
        <li>{t("kinds", { kinds })}</li>
        <li>
          {link.revokedAt
            ? t("revokedAt", { date: date(link.revokedAt) })
            : t("expires", { past: String(status === "expired"), date: date(link.expiresAt) })}
        </li>
        <li className={link.restricted ? "text-warning" : undefined}>
          {t("access", { restricted: String(link.restricted), count: link.targets.length })}
        </li>
      </ul>
      {link.accounts.length ? (
        <ul className="space-y-1" aria-label={t("accountsLabel", { label: link.label })}>
          {link.accounts.map((account) => (
            <li key={account.providerId} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{tProviders("kindShort", { kind: account.kind })}</span>
              <span className="min-w-0 break-all text-foreground">
                {tProviders("signIn.account", {
                  named: account.account ? "true" : "false",
                  account: account.account,
                })}
              </span>
              <Chip
                size="sm"
                variant="soft"
                color={account.status === "active" ? "success" : "warning"}
                className="whitespace-nowrap"
              >
                {tProviders("signIn.status", { status: account.status })}
              </Chip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("noAccounts")}</p>
      )}
    </li>
  );
}

export default function SubAddLinks({ antigravityReady }: { antigravityReady: boolean | null }) {
  const t = useTranslations("Subscriptions.subAdd");
  const tCommon = useTranslations("Common");
  const now = useNow({ updateInterval: 60_000 });
  const page = useActionData<SubAddLinksPayload>(() => loadSubAddLinksAction());
  const { data, setData } = page;
  const [created, setCreated] = useState<string | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const dialogState = useOverlayState();

  function openCreate() {
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  function onCreated(result: SubAddCreated) {
    setData((cur) => ({ ...cur, links: [result.link, ...cur.links] }));
    setCreated(result.url);
  }

  function onRevoked(link: SubAddLinkView) {
    setData((cur) => ({ ...cur, links: cur.links.map((row) => (row.id === link.id ? link : row)) }));
  }

  return (
    <Card aria-labelledby="sub-add-links-title">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <Card.Title id="sub-add-links-title">{t("title")}</Card.Title>
          <Card.Description>{t("description")}</Card.Description>
        </div>
        {data?.canManage ? (
          <Button size="sm" variant="secondary" onPress={openCreate}>
            <Link2 size={14} aria-hidden />
            {t("create")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content className="gap-3">
        {created ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content className="min-w-0">
              <Alert.Title>{t("createdTitle")}</Alert.Title>
              <Alert.Description>{t("createdHint")}</Alert.Description>
              <div className="mt-2 flex min-w-0 items-start gap-2">
                <Surface variant="secondary" className="min-w-0 flex-1 rounded-lg px-3 py-2">
                  <code className="font-mono text-sm break-all">{created}</code>
                </Surface>
                <CopyButton text={created} label={t("copy")} variant="secondary" />
              </div>
            </Alert.Content>
          </Alert>
        ) : null}
        {data ? (
          data.links.length ? (
            <ul className="divide-y divide-border">
              {data.links.map((link) => (
                <LinkRow key={link.id} link={link} now={now} canManage={data.canManage} onRevoked={onRevoked} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t("empty")}</p>
          )
        ) : page.error ? (
          <LoadError state={page} />
        ) : (
          <output aria-live="polite" aria-label={tCommon("loading")} className="flex justify-center py-4 text-accent">
            <Spinner color="current" />
          </output>
        )}
      </Card.Content>
      {data?.canManage ? (
        <SubAddDialog
          key={`sub-add-${dialogKey}`}
          state={dialogState}
          kinds={data.kinds}
          antigravityReady={antigravityReady}
          onCreated={onCreated}
        />
      ) : null}
    </Card>
  );
}
