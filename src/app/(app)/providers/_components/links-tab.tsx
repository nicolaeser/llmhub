"use client";

import { useState, useTransition } from "react";
import { Button, Chip, Dropdown, Meter, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { Link2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageStatus, { LoadError } from "@/components/console/page-status";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { useActionData } from "@/lib/hooks/use-action-data";
import { isActionFail } from "@/lib/http/action-result";
import { subAddRemaining, subAddStatus } from "@/lib/providers/sub-add-status";
import type { SignInKind } from "@/types/providers";
import type { SubAddLinksPayload, SubAddLinkView, SubAddStatus } from "@/types/sub-add";
import { deleteSubAddLinkAction, loadSubAddLinksAction } from "../_action";

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

  return { page, dialogKey, preset, dialogState, openCreate };
}

export type SubAddLinksState = ReturnType<typeof useSubAddLinks>;

function LinkActions({ link, onDeleted }: { link: SubAddLinkView; onDeleted: (id: string) => void }) {
  const t = useTranslations("Subscriptions.subAdd");
  const tCommon = useTranslations("Common");
  const showError = useErrorToast();
  const [deleting, startDelete] = useTransition();
  const confirmState = useOverlayState();

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
    <>
      <Dropdown>
        <Button isIconOnly size="sm" variant="tertiary" isPending={deleting} aria-label={t("actionsFor", { label: link.label })}>
          {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <MoreHorizontal size={14} aria-hidden />)}
        </Button>
        <Dropdown.Popover placement="bottom end">
          <Dropdown.Menu
            aria-label={t("actionsFor", { label: link.label })}
            onAction={(key) => {
              if (key === "delete") confirmState.open();
            }}
          >
            <Dropdown.Item id="delete" textValue={t("delete")} variant="danger">
              <Trash2 size={14} aria-hidden />
              {t("delete")}
            </Dropdown.Item>
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      <ConfirmDialog
        state={confirmState}
        title={t("deleteTitle", { label: link.label })}
        description={t("deleteDescription")}
        confirmLabel={t("delete")}
        cancelLabel={tCommon("cancel")}
        pending={deleting}
        onConfirm={remove}
      />
    </>
  );
}

export default function LinksTab({
  links,
  canManage,
  onCreate,
}: {
  links: SubAddLinksState;
  canManage: boolean;
  onCreate: () => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tSubscriptions = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { page } = links;
  const { data, setData } = page;

  if (!data) return <PageStatus state={page} layout="table" />;

  function onDeleted(id: string) {
    setData((current) => ({ ...current, links: current.links.filter((row) => row.id !== id) }));
  }

  if (data.links.length === 0) {
    return (
      <div className="space-y-5">
        <LoadError state={page} />
        <EmptyState
          icon={Link2}
          title={t("empty")}
          description={t("description")}
          action={
            canManage ? (
              <Button onPress={onCreate}>
                <Plus size={16} aria-hidden />
                {t("create")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const statusOf = (link: SubAddLinkView) => subAddStatus(link, now.getTime());

  const createdBy = (link: SubAddLinkView) =>
    t("createdBy", {
      named: link.createdBy ? "true" : "false",
      name: link.createdBy,
      date: format.dateTime(new Date(link.createdAt), { dateStyle: "medium" }),
    });

  const statusChip = (link: SubAddLinkView) => {
    const status = statusOf(link);
    return (
      <Chip size="sm" variant="soft" color={STATUS_COLOR[status]} className="whitespace-nowrap">
        {t("status", { status })}
      </Chip>
    );
  };

  const kindChips = (link: SubAddLinkView) =>
    link.kinds.map((kind) => {
      const Icon = kindIcon(kind);
      return (
        <Chip key={kind} size="sm" variant="soft" className="whitespace-nowrap">
          <Icon size={12} aria-hidden />
          {tProviders("kindShort", { kind })}
        </Chip>
      );
    });

  const accounts = (link: SubAddLinkView) =>
    link.maxAccounts !== null ? (
      <Meter
        value={link.added}
        maxValue={link.maxAccounts}
        color={subAddRemaining(link) === 0 ? "warning" : "accent"}
        aria-label={t("slots")}
        className="min-w-32"
      >
        <Meter.Output>{t("slotsValue", { added: link.added, max: link.maxAccounts })}</Meter.Output>
        <Meter.Track>
          <Meter.Fill />
        </Meter.Track>
      </Meter>
    ) : (
      <span className="text-sm text-foreground">{t("unlimited", { added: link.added })}</span>
    );

  const expires = (link: SubAddLinkView) => {
    const at = new Date(link.expiresAt);
    return (
      <span className="flex flex-col">
        <span className="text-sm text-foreground">{format.relativeTime(at, now)}</span>
        <span className="text-xs text-muted">{format.dateTime(at, { dateStyle: "medium", timeStyle: "short" })}</span>
      </span>
    );
  };

  const access = (link: SubAddLinkView) => (
    <span className={link.restricted ? "text-sm text-warning" : "text-sm text-foreground"}>
      {tSubscriptions("access.short", { restricted: String(link.restricted), count: link.targets.length })}
    </span>
  );

  return (
    <div className="space-y-5">
      <p className="max-w-3xl text-sm text-muted">{t("description")}</p>
      <LoadError state={page} />
      <RowCards label={t("title")}>
        {data.links.map((link) => (
          <RowCard
            key={link.id}
            title={link.label}
            description={createdBy(link)}
            aside={
              <>
                {statusChip(link)}
                {canManage ? <LinkActions link={link} onDeleted={onDeleted} /> : null}
              </>
            }
            chips={kindChips(link)}
            details={[
              { label: t("columns.accounts"), value: accounts(link), wide: true },
              { label: t("columns.expires"), value: expires(link) },
              { label: t("columns.access"), value: access(link) },
            ]}
          />
        ))}
      </RowCards>
      <Table aria-label={t("title")} className={TABLE_FROM_LG}>
        <Table.ScrollContainer>
          <Table.Content aria-label={t("title")} className="min-w-[56rem]">
            <Table.Header>
              <Table.Column isRowHeader>{t("columns.link")}</Table.Column>
              <Table.Column>{t("columns.providers")}</Table.Column>
              <Table.Column>{t("columns.accounts")}</Table.Column>
              <Table.Column>{t("columns.expires")}</Table.Column>
              <Table.Column>{t("columns.access")}</Table.Column>
              <Table.Column>{tCommon("status")}</Table.Column>
              {canManage ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
            </Table.Header>
            <Table.Body>
              {data.links.map((link) => (
                <Table.Row key={link.id} id={link.id}>
                  <Table.Cell>
                    <div className="font-medium break-words">{link.label}</div>
                    <div className="text-xs text-muted">{createdBy(link)}</div>
                  </Table.Cell>
                  <Table.Cell>
                    <div className="flex flex-wrap gap-1">{kindChips(link)}</div>
                  </Table.Cell>
                  <Table.Cell>{accounts(link)}</Table.Cell>
                  <Table.Cell>{expires(link)}</Table.Cell>
                  <Table.Cell>{access(link)}</Table.Cell>
                  <Table.Cell>{statusChip(link)}</Table.Cell>
                  {canManage ? (
                    <Table.Cell>
                      <LinkActions link={link} onDeleted={onDeleted} />
                    </Table.Cell>
                  ) : null}
                </Table.Row>
              ))}
            </Table.Body>
          </Table.Content>
        </Table.ScrollContainer>
      </Table>
    </div>
  );
}
