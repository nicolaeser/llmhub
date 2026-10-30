"use client";

import { useState, useTransition } from "react";
import { Button, Chip, Drawer, Dropdown, Meter, Spinner, toast, useOverlayState } from "@heroui/react";
import { Link2, MoreHorizontal, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import RowCard from "@/components/console/row-cards";
import { useErrorToast } from "@/components/console/use-error-toast";
import { kindIcon } from "@/components/providers/kind-icons";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import { subAddRemaining, subAddStatus } from "@/lib/providers/sub-add-status";
import type { SignInKind } from "@/types/providers";
import type { SubAddLinksPayload, SubAddLinkView, SubAddStatus } from "@/types/sub-add";
import { deleteSubAddLinkAction, loadSubAddLinksAction } from "../_action";

export const LINKS_OPEN = "open";

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

export function useLinksDrawer() {
  const open = useSearchParam("links") === LINKS_OPEN;
  return {
    open,
    setOpen: (next: boolean) => setSearchParams({ links: next ? LINKS_OPEN : null }),
  };
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
        description={t("deleteDescription", { manageable: String(link.manageable) })}
        confirmLabel={t("delete")}
        cancelLabel={tCommon("cancel")}
        pending={deleting}
        onConfirm={remove}
      />
    </>
  );
}

export default function LinksDrawer({
  links,
  open,
  canManage,
  onOpenChange,
  onCreate,
}: {
  links: SubAddLinksState;
  open: boolean;
  canManage: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: () => void;
}) {
  const t = useTranslations("Subscriptions.subAdd");
  const tSubscriptions = useTranslations("Subscriptions");
  const tProviders = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useClock(60_000);
  const { page } = links;
  const { data, setData } = page;

  function onDeleted(id: string) {
    setData((current) => ({ ...current, links: current.links.filter((row) => row.id !== id) }));
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

  const removal = (link: SubAddLinkView) => (
    <span className="text-sm text-foreground">{t("removal", { manageable: String(link.manageable) })}</span>
  );

  function body() {
    if (!data) return page.error === null ? <SectionLoading shape="list" /> : <LoadError state={page} />;
    if (data.links.length === 0) {
      return (
        <div className="space-y-4">
          <LoadError state={page} />
          <EmptyState
            icon={Link2}
            title={t("empty")}
            description={t("emptyHint")}
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
    return (
      <div className="space-y-4">
        <LoadError state={page} />
        <ul aria-label={t("title")} className="grid grid-cols-1 gap-3">
          {data.links.map((link) => (
            <RowCard
              key={link.id}
              variant="secondary"
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
                { label: t("columns.removal"), value: removal(link), wide: true },
              ]}
            />
          ))}
        </ul>
      </div>
    );
  }

  const listed = data?.links.length ?? 0;

  return (
    <Drawer.Backdrop variant="blur" isOpen={open} onOpenChange={onOpenChange}>
      <Drawer.Content placement="right">
        <Drawer.Dialog className="w-full sm:w-xl">
          <Drawer.CloseTrigger aria-label={tCommon("close")} />
          <Drawer.Header className="space-y-1 pr-10">
            <Drawer.Heading>{t("title")}</Drawer.Heading>
            <p className="text-sm text-muted">{t("description")}</p>
          </Drawer.Header>
          <Drawer.Body>{body()}</Drawer.Body>
          {canManage && listed > 0 ? (
            <Drawer.Footer>
              <Button onPress={onCreate}>
                <Plus size={16} aria-hidden />
                {t("create")}
              </Button>
            </Drawer.Footer>
          ) : null}
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  );
}
