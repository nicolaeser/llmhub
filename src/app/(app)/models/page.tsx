"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Spinner, Table, toast, useOverlayState } from "@heroui/react";
import { Network, Plus, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { Link } from "@/i18n/routing";
import ConfirmDialog from "@/components/console/confirm-dialog";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import { deleteModelGroupAction, loadModelsAction } from "@/app/(app)/models/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { Group, ProviderOpt } from "@/types/models";
import ModelGroupDialog from "./_components/model-group-dialog";

export default function ModelsPage() {
  const t = useTranslations("Models");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<Group[]>([]);
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  const [editing, setEditing] = useState<Group | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [, startDelete] = useTransition();
  const formState = useOverlayState();

  useEffect(() => {
    loadModelsAction().then((res) => {
      if (!isActionFail(res)) {
        setGroups(res.groups);
        setProviders(res.providers);
      }
      setLoading(false);
    });
  }, []);

  function openDialog(group: Group | null) {
    setEditing(group);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function saved(group: Group) {
    setGroups((cur) =>
      cur.some((g) => g.alias === group.alias)
        ? cur.map((g) => (g.alias === group.alias ? group : g))
        : [...cur, group].sort((a, b) => a.alias.localeCompare(b.alias)),
    );
  }

  function remove(alias: string) {
    setDeleting(alias);
    startDelete(async () => {
      const result = await deleteModelGroupAction(alias);
      setDeleting(null);
      if (isActionFail(result)) {
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      setGroups((cur) => cur.filter((g) => g.alias !== result.alias));
      toast(t("toasts.deleted"), { variant: "success" });
    });
  }

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const createButton = (
    <Button
      aria-label={t("add")}
      onPress={() => openDialog(null)}
    >
      <Plus size={16} aria-hidden />
      {t("add")}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={groups.length ? createButton : undefined}
      />

      {groups.length === 0 ? (
        <EmptyState
          icon={Network}
          title={t("emptyTitle")}
          description={
            providers.length === 0
              ? t.rich("needProvider", {
                  providers: (chunks) => (
                    <Link href="/providers" className="text-accent">
                      {chunks}
                    </Link>
                  ),
                })
              : t("empty")
          }
          action={
            providers.length === 0 ? (
              <Link href="/providers" className="text-sm font-medium text-accent">
                {t("connectProvider")}
              </Link>
            ) : (
              createButton
            )
          }
        />
      ) : (
        <Table aria-label={t("title")}>
          <Table.ScrollContainer>
            <Table.Content>
              <Table.Header>
                <Table.Column isRowHeader>{t("columns.alias")}</Table.Column>
                <Table.Column>{t("columns.strategy")}</Table.Column>
                <Table.Column>{t("columns.endpoints")}</Table.Column>
                <Table.Column>{t("columns.overflow")}</Table.Column>
                <Table.Column>{tCommon("actions")}</Table.Column>
              </Table.Header>
              <Table.Body>
                {groups.map((g) => (
                  <Table.Row key={g.alias} id={g.alias}>
                    <Table.Cell>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="font-medium"
                        onPress={() => openDialog(g)}
                      >
                        {g.alias}
                      </Button>
                    </Table.Cell>
                    <Table.Cell>{t("strategyLabel", { strategy: g.strategy })}</Table.Cell>
                    <Table.Cell>{format.number(g.endpoints, "integer")}</Table.Cell>
                    <Table.Cell>{g.overflowGroup || tCommon("none")}</Table.Cell>
                    <Table.Cell>
                      <div className="flex gap-1">
                        <Button
                          size="sm"
                          variant="secondary"
                          aria-label={tCommon("edit")}
                          onPress={() => openDialog(g)}
                        >
                          {tCommon("edit")}
                        </Button>
                        <ConfirmDialog
                          title={t("removeConfirm", { alias: g.alias })}
                          confirmLabel={tCommon("delete")}
                          cancelLabel={tCommon("cancel")}
                          pending={deleting === g.alias}
                          onConfirm={() => remove(g.alias)}
                        >
                          <Button
                            isIconOnly
                            size="sm"
                            variant="danger-soft"
                            aria-label={tCommon("delete")}
                            isPending={deleting === g.alias}
                          >
                            <Trash2 size={14} aria-hidden />
                          </Button>
                        </ConfirmDialog>
                      </div>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Content>
          </Table.ScrollContainer>
        </Table>
      )}

      <ModelGroupDialog
        key={dialogKey}
        state={formState}
        editing={editing}
        providers={providers}
        onSaved={saved}
      />
    </div>
  );
}
