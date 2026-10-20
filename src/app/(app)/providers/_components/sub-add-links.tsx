"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Meter, Label, Spinner, toast, useOverlayState } from "@heroui/react";
import { CalendarClock, Link2, Plus, ShieldCheck, Trash2, Users } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import IconTile from "@/components/console/icon-tile";
import { LoadError } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { subAddRemaining, subAddStatus } from "@/lib/providers/sub-add-status";
import type { SignInKind } from "@/types/providers";
import type { SubAddCreated, SubAddLinksPayload, SubAddLinkView, SubAddStatus } from "@/types/sub-add";
import { deleteSubAddLinkAction, loadSubAddLinksAction } from "../_action";
import SubAddDialog from "./sub-add-dialog";

const STATUS_COLOR = {
  active: "success",
  used_up: "warning",
  expired: "default",
} as const satisfies Record<SubAddStatus, "success" | "warning" | "default">;

export function useSubAddLinks() {
  const page = useActionData<SubAddLinksPayload>(() => loadSubAddLinksAction());
  const [dialogKey, setDialogKey] = useState(0);
  const [preset, setPreset] = useState<SignInKind | null>(null);
  const dialogState = useOverlayState();

  function openCreate(kind: SignInKind | null) {
    setPreset(kind);
    setDialogKey((n) => n + 1);
    dialogState.open();
  }

  return { page, dialogKey, preset, dialogState, openCreate, canManage: page.data?.canManage ?? false };
}

function LinkCard({
  link,
  now,
  canManage,
  onDeleted,
}: {
  link: SubAddLinkView;
  now: Date;
  canManage: boolean;
  onDeleted: (id: string) => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const showError = useErrorToast();
  const [deleting, startDelete] = useTransition();
  const status = subAddStatus(link, now.getTime());
  const remaining = subAddRemaining(link);
  const expires = new Date(link.expiresAt);

  function remove() {
    startDelete(async () => {
      const result = await deleteSubAddLinkAction(link.id);
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      onDeleted(result.id);
      toast(t("deleted", { label: link.label }), { variant: "success" });
    });
  }

  return (
    <li className="min-w-0">
      <Card variant="secondary" className="h-full gap-4">
        <Card.Header className="flex-row flex-wrap items-start gap-3">
          <IconTile icon={Link2} tone={status === "active" ? "accent" : "neutral"} />
          <div className="min-w-0 flex-1 basis-40">
            <Card.Title className="break-words">{link.label}</Card.Title>
            <Card.Description>
              {t("createdBy", {
                named: link.createdBy ? "true" : "false",
                name: link.createdBy,
                date: format.dateTime(new Date(link.createdAt), { dateStyle: "medium" }),
              })}
            </Card.Description>
          </div>
          <div className="flex items-center gap-1">
            <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} className="whitespace-nowrap">
              {t("status", { status })}
            </Chip>
            {canManage ? (
              <ConfirmDialog
                title={t("deleteTitle", { label: link.label })}
                description={t("deleteDescription")}
                confirmLabel={t("delete")}
                cancelLabel={tCommon("cancel")}
                pending={deleting}
                onConfirm={remove}
              >
                <Button
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                  isPending={deleting}
                  aria-label={t("deleteLabel", { label: link.label })}
                >
                  {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <Trash2 size={14} aria-hidden />)}
                </Button>
              </ConfirmDialog>
            ) : null}
          </div>
        </Card.Header>
        <Card.Content className="gap-4">
          <div className="flex flex-wrap gap-1">
            {link.kinds.map((kind) => {
              const Icon = kindIcon(kind);
              return (
                <Chip key={kind} size="sm" variant="soft" className="whitespace-nowrap">
                  <Icon size={12} aria-hidden />
                  {tProviders("kindShort", { kind })}
                </Chip>
              );
            })}
          </div>
          {link.maxAccounts !== null ? (
            <Meter value={link.added} maxValue={link.maxAccounts} color={remaining === 0 ? "warning" : "accent"} aria-label={t("slots")}>
              <Label>{t("slots")}</Label>
              <Meter.Output>{t("slotsValue", { added: link.added, max: link.maxAccounts })}</Meter.Output>
              <Meter.Track>
                <Meter.Fill />
              </Meter.Track>
            </Meter>
          ) : (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Users size={14} aria-hidden className="shrink-0" />
              {t("unlimited", { added: link.added })}
            </p>
          )}
          <ul className="space-y-1.5 text-sm text-muted">
            <li className="flex items-center gap-2">
              <CalendarClock size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0">
                {t("expires", {
                  past: String(status === "expired"),
                  when: format.relativeTime(expires, now),
                  date: format.dateTime(expires, { dateStyle: "medium", timeStyle: "short" }),
                })}
              </span>
            </li>
            <li className={link.restricted ? "flex items-center gap-2 text-warning" : "flex items-center gap-2"}>
              <ShieldCheck size={14} aria-hidden className="shrink-0" />
              <span className="min-w-0">{t("access", { restricted: String(link.restricted), count: link.targets.length })}</span>
            </li>
          </ul>
          {link.accounts.length ? (
            <ul className="space-y-1.5" aria-label={t("accountsLabel", { label: link.label })}>
              {link.accounts.map((account) => (
                <li key={account.providerId} className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                  <IconTile icon={kindIcon(account.kind)} tone="neutral" size="sm" />
                  <span className="min-w-0 flex-1 break-all text-foreground">
                    {tProviders("signIn.account", { named: account.account ? "true" : "false", account: account.account })}
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
        </Card.Content>
      </Card>
    </li>
  );
}

export default function SubAddLinks({
  links,
  antigravityReady,
}: {
  links: ReturnType<typeof useSubAddLinks>;
  antigravityReady: boolean | null;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tCommon = useTranslations("Common");
  const now = useNow({ updateInterval: 60_000 });
  const { page } = links;
  const { data, setData } = page;

  function onCreated(result: SubAddCreated) {
    setData((cur) => ({ ...cur, links: [result.link, ...cur.links] }));
  }

  function onDeleted(id: string) {
    setData((cur) => ({ ...cur, links: cur.links.filter((row) => row.id !== id) }));
  }

  return (
    <Card aria-labelledby="sub-add-links-title" className="gap-5">
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
          <IconTile icon={Link2} />
          <div className="min-w-0 flex-1">
            <Card.Title id="sub-add-links-title">{t("title")}</Card.Title>
            <Card.Description>{t("description")}</Card.Description>
          </div>
        </div>
        {data?.canManage ? (
          <Button size="sm" variant="secondary" onPress={() => links.openCreate(null)}>
            <Plus size={14} aria-hidden />
            {t("create")}
          </Button>
        ) : null}
      </Card.Header>
      <Card.Content>
        {data ? (
          data.links.length ? (
            <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
              {data.links.map((link) => (
                <LinkCard key={link.id} link={link} now={now} canManage={data.canManage} onDeleted={onDeleted} />
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
          key={`sub-add-${links.dialogKey}`}
          state={links.dialogState}
          kinds={data.kinds}
          preset={links.preset}
          antigravityReady={antigravityReady}
          onCreated={onCreated}
        />
      ) : null}
    </Card>
  );
}
