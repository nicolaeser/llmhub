"use client";

import { useState, useTransition } from "react";
import { Button, Card, Chip, Skeleton, Spinner } from "@heroui/react";
import { Blocks, ChevronRight, KeyRound, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { LoadError, SectionLoading } from "@/components/console/page-status";
import { bindingKind } from "@/components/keys/key-binding";
import { useKeyDialogs, type KeyServerActions } from "@/components/keys/use-key-dialogs";
import { logsHref } from "@/lib/gateway/request-logs/request-log-query";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useClock } from "@/lib/hooks/use-clock";
import { usageHref } from "@/lib/usage/usage-query";
import type { ActionFail } from "@/types/actions";
import type { KeyChoices, KeyDetail, VirtualKeyView } from "@/types/keys";
import type { BudgetTarget, KeyNode, NodeRef, StructurePayload } from "@/types/structure";
import BudgetCard from "./budget-card";
import InsightLinks from "./insight-links";
import { keyOptionsOf } from "./key-model";
import NodeHeader from "./node-header";
import { chainOf, nodeAlias, nodePath } from "./tree-model";

const WHOLE_DAY = "00:00";

function namedTemplates(ids: string[], known: { id: string; name: string }[]) {
  return ids.flatMap((id) => {
    const name = known.find((template) => template.id === id)?.name;
    return name ? [{ id, name }] : [];
  });
}

export default function KeyPane({
  data,
  node,
  actions,
  loadKey,
  loadChoices,
  onOpen,
  onBudget,
  onChanged,
  onRevoked,
}: {
  data: StructurePayload;
  node: KeyNode;
  actions: KeyServerActions;
  loadKey: (id: string) => Promise<KeyDetail | ActionFail>;
  loadChoices: () => Promise<KeyChoices | null>;
  onOpen: (ref: NodeRef) => void;
  onBudget: (target: BudgetTarget, dialog: "budget" | "boost") => void;
  onChanged: (key: VirtualKeyView) => void;
  onRevoked: (id: string) => void;
}) {
  const t = useTranslations("Companies.key");
  const tKeys = useTranslations("Keys");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const now = useClock(60_000);
  const [choices, setChoices] = useState<KeyChoices | null>(null);
  const [opening, startOpening] = useTransition();
  const detail = useActionData(() => loadKey(node.id));
  const keyDialogs = useKeyDialogs({
    actions,
    canBind: data.canManage,
    onSaved: (row) => {
      detail.setData((current) => ({
        key: row,
        templates: namedTemplates(row.templates, [...current.templates, ...(choices?.templates ?? [])]),
      }));
      onChanged(row);
    },
    onRevoked,
  });
  const key = detail.data?.key ?? null;
  const ref: NodeRef = { kind: "key", id: node.id };
  const target = { id: node.id, name: node.alias };
  const budgetTarget = { kind: "key" as const, id: node.id, alias: node.alias };
  const binding = bindingKind({ project_id: node.projectId, member_id: node.memberId });
  const path = nodePath(data, ref);
  const place = path.find((link) => link.kind === "project" || link.kind === "member");
  const org = path.find((link) => link.kind === "org");
  const team = path.find((link) => link.kind === "team");
  const expires = key?.expires ? new Date(key.expires) : null;
  const expired = expires !== null && expires <= now;

  function edit() {
    if (!key) return;
    startOpening(async () => {
      const loaded = await loadChoices();
      if (!loaded) return;
      setChoices(loaded);
      keyDialogs.openEdit(keyOptionsOf(data, loaded), key);
    });
  }

  const chips = (
    <>
      {node.blocked ? (
        <Chip size="sm" variant="soft" color="danger">
          {tCommon("blockedState", { blocked: "true" })}
        </Chip>
      ) : null}
      {key ? (
        <>
          {key.log_content ? null : (
            <Chip size="sm" variant="soft" color="warning">
              {tKeys("contentOff")}
            </Chip>
          )}
          {expires ? (
            <Chip size="sm" variant="soft" color={expired ? "danger" : "default"}>
              {t("expiresChip", { state: expired ? "expired" : "active", date: expires })}
            </Chip>
          ) : null}
        </>
      ) : detail.error === null ? (
        <Skeleton className="h-5 w-20 rounded-2xl" />
      ) : null}
    </>
  );

  const headerActions =
    data.canManageKeys || data.canMcp || data.canSeeUsage ? (
      <>
        {data.canSeeUsage ? (
          <InsightLinks usage={usageHref({ keyId: node.id })} logs={logsHref({ keyId: node.id })} />
        ) : null}
        {data.canManageKeys ? (
          <Button size="sm" variant="secondary" isPending={opening} isDisabled={!key} onPress={edit}>
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <Pencil size={14} aria-hidden />}
                {tKeys("edit")}
              </>
            )}
          </Button>
        ) : null}
        {data.canMcp ? (
          <Button size="sm" variant="secondary" onPress={() => keyDialogs.openMcp(target)}>
            <Blocks size={14} aria-hidden />
            {tKeys("mcp.action")}
          </Button>
        ) : null}
        {data.canManageKeys ? (
          <Button
            size="sm"
            variant="secondary"
            isPending={keyDialogs.busy?.action === "rotate"}
            isDisabled={keyDialogs.busy !== null}
            onPress={() => keyDialogs.askRotate(target)}
          >
            {({ isPending }) => (
              <>
                {isPending ? <Spinner color="current" size="sm" /> : <RefreshCw size={14} aria-hidden />}
                {tKeys("rotate")}
              </>
            )}
          </Button>
        ) : null}
        {data.canManageKeys ? (
          <Button
            isIconOnly
            size="sm"
            variant="danger-soft"
            aria-label={tKeys("revoke")}
            isPending={keyDialogs.busy?.action === "revoke"}
            isDisabled={keyDialogs.busy !== null}
            onPress={() => keyDialogs.askRevoke(target)}
          >
            {({ isPending }) => (isPending ? <Spinner color="current" size="sm" /> : <Trash2 size={14} aria-hidden />)}
          </Button>
        ) : null}
      </>
    ) : undefined;

  function windowsValue(row: VirtualKeyView) {
    if (!row.access_windows.length) return t("anyTime");
    return (
      <>
        {row.access_windows.map((window, index) => (
          <span key={index} className="block">
            {t("window", {
              days: format.list(
                window.days.map((day) => tKeys("windows.dayShort", { day })),
                { type: "unit" },
              ),
              allDay: window.start === WHOLE_DAY && window.end === WHOLE_DAY ? "yes" : "no",
              start: window.start,
              end: window.end,
            })}
          </span>
        ))}
        <span className="block text-xs text-muted">{t("timeZone", { zone: row.access_time_zone })}</span>
      </>
    );
  }

  function accessCard(row: VirtualKeyView, templates: { id: string; name: string }[]) {
    const open = !row.models.length && !row.templates.length;
    return (
      <Card>
        <Card.Header>
          <Card.Title>{t("accessTitle")}</Card.Title>
          <Card.Description>
            {open ? tKeys("access", { state: "all", count: 0 }) : t("accessHint")}
          </Card.Description>
        </Card.Header>
        <Card.Content>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("templates")}</dt>
              <dd className="text-sm break-words">
                {templates.length
                  ? format.list(
                      templates.map((template) => template.name),
                      { type: "unit" },
                    )
                  : t("none")}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("models")}</dt>
              <dd className="text-sm break-words">
                {row.models.length ? format.list(row.models, { type: "unit" }) : t("none")}
              </dd>
            </div>
          </dl>
        </Card.Content>
      </Card>
    );
  }

  function limitsCard(row: VirtualKeyView) {
    const items = [
      {
        label: t("rpm"),
        value: row.rpm_limit > 0 ? format.number(row.rpm_limit, "integer") : t("unlimited"),
      },
      {
        label: t("tpm"),
        value: row.tpm_limit > 0 ? format.number(row.tpm_limit, "integer") : t("unlimited"),
      },
      {
        label: t("maxRequestCost"),
        value: row.max_request_cost > 0 ? format.number(row.max_request_cost, "price") : t("unlimited"),
      },
      {
        label: t("content"),
        value: t("contentState", { logged: row.log_content ? "yes" : "no" }),
      },
      {
        label: t("ips"),
        value: row.allowed_ips.length ? format.list(row.allowed_ips, { type: "unit" }) : t("anyIp"),
      },
      {
        label: t("endpoints"),
        value: row.allowed_endpoints.length
          ? format.list(
              row.allowed_endpoints.map((endpoint) => tKeys("endpoints.name", { endpoint })),
              { type: "conjunction" },
            )
          : t("allEndpoints"),
      },
      { label: t("windows"), value: windowsValue(row) },
    ];
    return (
      <Card>
        <Card.Header>
          <Card.Title>{t("limitsTitle")}</Card.Title>
          <Card.Description>{t("limitsHint")}</Card.Description>
        </Card.Header>
        <Card.Content>
          <dl className="grid gap-4 sm:grid-cols-2">
            {items.map((item) => (
              <div key={item.label} className="min-w-0">
                <dt className="text-xs text-muted">{item.label}</dt>
                <dd className="text-sm break-words">{item.value}</dd>
              </div>
            ))}
          </dl>
        </Card.Content>
      </Card>
    );
  }

  function expiryCard(row: VirtualKeyView) {
    return (
      <Card>
        <Card.Header>
          <Card.Title>{t("expiryTitle")}</Card.Title>
          <Card.Description>{t("expiryHint", { expires: expires ? "yes" : "no" })}</Card.Description>
        </Card.Header>
        <Card.Content>
          <dl className="grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("expires")}</dt>
              <dd className={`text-sm ${expired ? "text-danger" : ""}`}>
                {expires ? format.dateTime(expires, "stamp") : t("never")}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("created")}</dt>
              <dd className="text-sm">{format.dateTime(new Date(row.created_at), "stamp")}</dd>
            </div>
          </dl>
        </Card.Content>
      </Card>
    );
  }

  const owner = binding === "internal" ? nodeAlias(data, "user", node.userId) : (place?.alias ?? "");

  return (
    <>
      <NodeHeader
        icon={KeyRound}
        path={path}
        title={node.alias}
        subtitle={t("summary", { binding, prefix: node.prefix })}
        chips={chips}
        actions={headerActions}
        onOpen={onOpen}
      />

      {keyDialogs.notice}

      <BudgetCard
        chain={chainOf(data, "key", node.id)}
        budget={node.budget}
        thresholds={data.thresholds}
        canBudget={data.canBudget}
        canSeeSettings={data.canSeeSettings}
        onEdit={() => onBudget(budgetTarget, "budget")}
        onBoost={() => onBudget(budgetTarget, "boost")}
      />

      <Card>
        <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Card.Title>{t("bindingTitle")}</Card.Title>
            <Card.Description>{t("bindingHint", { binding })}</Card.Description>
          </div>
          {place ? (
            <Button size="sm" variant="secondary" onPress={() => onOpen({ kind: place.kind, id: place.id })}>
              {t("open", { binding })}
              <ChevronRight size={14} aria-hidden />
            </Button>
          ) : null}
        </Card.Header>
        <Card.Content>
          <dl className="grid grid-cols-2 gap-4">
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("bindingName", { binding })}</dt>
              <dd className="text-sm break-words">{owner || tCommon("none")}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted">{t("place")}</dt>
              <dd className="text-sm break-words">
                {tKeys("binding.place", {
                  org: org?.alias ?? "",
                  team: team?.alias ?? "",
                  hasTeam: team ? "yes" : "no",
                })}
              </dd>
            </div>
          </dl>
        </Card.Content>
      </Card>

      {detail.data ? (
        <>
          <div className="grid gap-5 xl:grid-cols-2">
            {accessCard(detail.data.key, detail.data.templates)}
            {expiryCard(detail.data.key)}
          </div>
          {limitsCard(detail.data.key)}
        </>
      ) : detail.error !== null ? (
        <LoadError state={detail} />
      ) : (
        <SectionLoading shape="details" />
      )}

      {keyDialogs.dialogs}
    </>
  );
}
