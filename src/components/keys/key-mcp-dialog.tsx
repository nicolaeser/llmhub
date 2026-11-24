"use client";

import { useEffect, useState, useTransition } from "react";
import { Alert, Card, Chip, Disclosure, SearchField, Separator, toast, type useOverlayState } from "@heroui/react";
import { Blocks, SearchX } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import FormDialog from "@/components/console/form-dialog";
import { SectionLoading } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import AccessLevelField from "@/components/mcp/access-level-field";
import { useAccessLabels } from "@/components/mcp/access-labels";
import ToolAccessList from "@/components/mcp/tool-access-list";
import { isActionFail } from "@/lib/http/action-result";
import { ceilingOf, cleanGrant, explainAccess } from "@/lib/mcp/resolve";
import type { ActionFail } from "@/types/actions";
import type {
  McpAssignmentView,
  McpCeiling,
  McpExplanation,
  McpKeyAccess,
  McpKeyAccessChoice,
  McpKeyServerAccess,
} from "@/types/mcp";

const SEARCH_FROM = 6;

type ServerStatus = "paused" | "blocked" | "none" | "unconnected" | "available";

function choiceOf(server: McpKeyServerAccess): McpKeyAccessChoice {
  const rule = server.rule;
  if (!rule) return { serverId: server.serverId, access: "inherit", extraTools: [], blockedTools: [] };
  return { serverId: server.serverId, access: rule.access, extraTools: rule.extraTools, blockedTools: rule.blockedTools };
}

function sorted(names: string[]): string {
  return [...names].sort().join("\n");
}

function sameChoice(a: McpKeyAccessChoice, b: McpKeyAccessChoice): boolean {
  const left = cleanGrant(a);
  const right = cleanGrant(b);
  if (!left || !right) return !left && !right;
  return (
    left.access === right.access &&
    sorted(left.extraTools) === sorted(right.extraTools) &&
    sorted(left.blockedTools) === sorted(right.blockedTools)
  );
}

function keyRule(access: McpKeyAccess, choice: McpKeyAccessChoice): McpAssignmentView | null {
  const grant = cleanGrant(choice);
  return grant ? { scope: "key", id: access.keyId, label: access.label, ...grant } : null;
}

function explain(access: McpKeyAccess, server: McpKeyServerAccess, choice: McpKeyAccessChoice | null): McpExplanation {
  const own = choice ? keyRule(access, choice) : null;
  return explainAccess(server, own ? [...server.inherited, own] : server.inherited, access.chain);
}

function ceilingFor(access: McpKeyAccess, server: McpKeyServerAccess, choice: McpKeyAccessChoice): McpCeiling {
  if (choice.access !== "inherit") return ceilingOf(server, server.inherited);
  const base = explain(access, server, null);
  const names = new Set(base.tools);
  return {
    level: base.state === "granted" ? base.level : null,
    limitedBy: base.limitedBy,
    allows: (tool) => names.has(tool.name),
  };
}

function statusOf(server: McpKeyServerAccess, explanation: McpExplanation): ServerStatus {
  if (!server.enabled) return "paused";
  if (explanation.state === "blocked") return "blocked";
  if (explanation.state === "none") return "none";
  if (!server.connected) return "unconnected";
  return "available";
}

function statusColor(status: ServerStatus): "success" | "warning" | "danger" | "default" {
  if (status === "available") return "success";
  if (status === "unconnected") return "warning";
  if (status === "blocked") return "danger";
  return "default";
}

export default function KeyMcpDialog({
  state,
  keyId,
  keyName,
  onLoad,
  onSave,
}: {
  state: ReturnType<typeof useOverlayState>;
  keyId: string | null;
  keyName: string;
  onLoad: (keyId: string) => Promise<McpKeyAccess | ActionFail>;
  onSave: (input: { keyId: string; servers: McpKeyAccessChoice[] }) => Promise<McpKeyAccess | ActionFail>;
}) {
  const t = useTranslations("Keys.mcp");
  const tMcp = useTranslations("Mcp");
  const tAccess = useTranslations("Mcp.access");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const labels = useAccessLabels();
  const showError = useErrorToast();
  const [access, setAccess] = useState<McpKeyAccess | null>(null);
  const [choices, setChoices] = useState<Record<string, McpKeyAccessChoice>>({});
  const [failed, setFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [saving, startSave] = useTransition();

  useEffect(() => {
    if (!keyId) return;
    let active = true;
    onLoad(keyId).then((result) => {
      if (!active) return;
      if (isActionFail(result)) {
        showError(result.error);
        setFailed(true);
        return;
      }
      setAccess(result);
      setChoices(Object.fromEntries(result.servers.map((server) => [server.serverId, choiceOf(server)])));
    });
    return () => {
      active = false;
    };
  }, [keyId, onLoad, showError]);

  const servers = access?.servers ?? [];
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? servers.filter((server) => [server.name, server.description].some((value) => value.toLowerCase().includes(needle)))
    : servers;
  const changed = access
    ? access.servers.filter((server) => choices[server.serverId] && !sameChoice(choices[server.serverId]!, choiceOf(server)))
    : [];
  const totals = access
    ? access.servers.reduce(
        (sum, server) => {
          const explanation = explain(access, server, choices[server.serverId] ?? null);
          if (statusOf(server, explanation) !== "available") return sum;
          return { servers: sum.servers + 1, tools: sum.tools + explanation.tools.length };
        },
        { servers: 0, tools: 0 },
      )
    : { servers: 0, tools: 0 };

  function update(serverId: string, change: Partial<McpKeyAccessChoice>) {
    setChoices((current) => {
      const previous = current[serverId];
      if (!previous) return current;
      return { ...current, [serverId]: { ...previous, ...change } };
    });
  }

  function aboveLine(server: McpKeyServerAccess): string {
    if (!access) return "";
    const parts = [
      ...(server.defaultAccess !== "none" ? [`${tAccess("defaultSource")}: ${tAccess("level", { access: server.defaultAccess })}`] : []),
      ...server.inherited.map((rule) => `${labels.source({ kind: "rule", rule })}: ${labels.summary(rule)}`),
    ];
    if (!parts.length) return t("aboveNone");
    return tAccess("above", { list: format.list(parts, { type: "conjunction" }) });
  }

  function save(close: () => void) {
    if (!access || !changed.length) return;
    startSave(async () => {
      const result = await onSave({
        keyId: access.keyId,
        servers: changed.map((server) => choices[server.serverId]!),
      });
      if (isActionFail(result)) {
        showError(result.error);
        return;
      }
      setAccess(result);
      setChoices(Object.fromEntries(result.servers.map((server) => [server.serverId, choiceOf(server)])));
      toast(t("saved"), { variant: "success" });
      close();
    });
  }

  return (
    <FormDialog
      state={state}
      size="2xl"
      title={t("title", { name: keyName })}
      description={t("description")}
      submitLabel={t("save", { count: changed.length })}
      pending={saving}
      isSubmitDisabled={!access || !changed.length}
      onSubmit={save}
    >
      {!access ? (
        failed ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Description>{t("loadFailed")}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <SectionLoading rows={4} />
        )
      ) : servers.length === 0 ? (
        <EmptyState icon={Blocks} title={t("emptyTitle")} description={t("emptyDescription")} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Chip size="sm" variant="soft" color={totals.servers ? "success" : "default"}>
              {t("summaryServers", { count: totals.servers, total: servers.length })}
            </Chip>
            <Chip size="sm" variant="soft">
              {t("summaryTools", { count: totals.tools })}
            </Chip>
            {changed.length ? (
              <Chip size="sm" variant="soft" color="accent">
                {t("unsaved", { count: changed.length })}
              </Chip>
            ) : null}
          </div>
          {servers.length >= SEARCH_FROM ? (
            <SearchField value={search} onChange={setSearch} aria-label={t("search")} className="w-full">
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder={t("search")} />
                <SearchField.ClearButton aria-label={tCommon("close")} />
              </SearchField.Group>
            </SearchField>
          ) : null}
          {shown.length === 0 ? <EmptyState icon={SearchX} title={t("noMatch")} /> : null}
          {shown.map((server) => {
            const choice = choices[server.serverId] ?? choiceOf(server);
            const explanation = explain(access, server, choice);
            const status = statusOf(server, explanation);
            const ceiling = ceilingFor(access, server, choice);
            return (
              <Card key={server.serverId} variant="secondary">
                <Card.Content>
                  <Disclosure>
                    <Disclosure.Heading>
                      <Disclosure.Trigger className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
                        <span className="flex min-w-0 flex-wrap items-center gap-2">
                          <span className="font-medium break-all text-foreground">{server.name}</span>
                          {server.kind === "hosted" ? (
                            <Chip size="sm" variant="soft">
                              {tMcp("hosted")}
                            </Chip>
                          ) : null}
                          {server.kind === "media" ? (
                            <Chip size="sm" variant="soft">
                              {tMcp("media.badge")}
                            </Chip>
                          ) : null}
                          {sameChoice(choice, choiceOf(server)) ? null : (
                            <Chip size="sm" variant="soft" color="accent">
                              {t("changed")}
                            </Chip>
                          )}
                        </span>
                        <span className="flex items-center gap-2">
                          <Chip size="sm" variant="soft" color={statusColor(status)}>
                            {status === "available"
                              ? t("toolCount", { count: explanation.tools.length, total: server.tools.length })
                              : t("status", { status })}
                          </Chip>
                          <Disclosure.Indicator />
                        </span>
                      </Disclosure.Trigger>
                    </Disclosure.Heading>
                    <Disclosure.Content>
                      <Disclosure.Body className="flex flex-col gap-4 pt-4">
                        {server.description ? <p className="text-sm text-muted">{server.description}</p> : null}
                        <p className="text-sm text-muted">{aboveLine(server)}</p>
                        {status === "unconnected" ? (
                          <Alert status="warning">
                            <Alert.Indicator />
                            <Alert.Content>
                              <Alert.Description>{t("unconnected")}</Alert.Description>
                            </Alert.Content>
                          </Alert>
                        ) : null}
                        <AccessLevelField
                          value={choice.access}
                          onChange={(next) =>
                            update(server.serverId, {
                              access: next,
                              extraTools: [],
                              blockedTools: next === "none" ? [] : choice.blockedTools,
                            })
                          }
                          context="rule"
                          ceiling={choice.access === "inherit" ? null : ceiling.level}
                          ceilingSource={ceiling.limitedBy ? labels.source(ceiling.limitedBy) : undefined}
                          isDisabled={saving}
                        />
                        <Separator />
                        <ToolAccessList
                          tools={server.tools}
                          grant={choice}
                          ceiling={ceiling}
                          onChange={(next) => update(server.serverId, next)}
                          isDisabled={saving}
                        />
                      </Disclosure.Body>
                    </Disclosure.Content>
                  </Disclosure>
                </Card.Content>
              </Card>
            );
          })}
        </>
      )}
    </FormDialog>
  );
}
