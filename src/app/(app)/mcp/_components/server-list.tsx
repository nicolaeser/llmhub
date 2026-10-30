"use client";

import { useState } from "react";
import { ListBox, SearchField, Select, Table } from "@heroui/react";
import { SearchX } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { setSearchParams, useSearchParam } from "@/lib/hooks/use-search-param";
import type { McpServerView } from "@/types/mcp";
import ServerActions, { type ServerFlags, type ServerHandlers } from "./server-actions";
import { ServerAccess, ServerKindChips, ServerName, ServerStatus, ServerStatusChip, ServerStatusLine, ServerTools } from "./server-row";
import { inFilter, matchesQuery, SERVER_FILTERS, serverFilterOf } from "./server-view";

const SEARCH_FROM = 6;

export default function ServerList({
  servers,
  flags,
  handlers,
}: {
  servers: McpServerView[];
  flags: ServerFlags;
  handlers: ServerHandlers;
}) {
  const t = useTranslations("Mcp");
  const tCommon = useTranslations("Common");
  const [query, setQuery] = useState("");
  const status = useSearchParam("status");
  const legacyTab = useSearchParam("tab");
  const filter = serverFilterOf(status ?? legacyTab);
  const rows = servers.filter((server) => inFilter(server, filter) && matchesQuery(server, query));
  const showActions = flags.canManage || flags.canAssign || flags.canInstall;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        {servers.length >= SEARCH_FROM ? (
          <SearchField value={query} onChange={setQuery} aria-label={t("list.search")} className="w-full sm:max-w-xs">
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder={t("list.search")} />
              <SearchField.ClearButton aria-label={tCommon("close")} />
            </SearchField.Group>
          </SearchField>
        ) : null}
        <Select
          aria-label={t("list.filter")}
          className="w-full sm:w-56"
          selectedKey={filter}
          onSelectionChange={(key) => {
            const next = serverFilterOf(String(key));
            setSearchParams({ status: next === "all" ? null : next, tab: null });
          }}
        >
          <Select.Trigger>
            <Select.Value />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox aria-label={t("list.filter")}>
              {SERVER_FILTERS.map((id) => {
                const label = t("list.filterOption", {
                  filter: id,
                  count: servers.filter((server) => inFilter(server, id)).length,
                });
                return (
                  <ListBox.Item key={id} id={id} textValue={label}>
                    {label}
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                );
              })}
            </ListBox>
          </Select.Popover>
        </Select>
      </div>
      {rows.length === 0 ? (
        <EmptyState icon={SearchX} title={t("list.noMatchesTitle")} description={t("list.noMatches")} />
      ) : (
        <>
          <RowCards label={t("title")}>
            {rows.map((server) => (
              <RowCard
                key={server.id}
                title={server.name}
                description={server.description || <span className="font-mono text-xs break-all">{server.url}</span>}
                aside={<ServerStatusChip server={server} />}
                chips={
                  server.kind === "hosted" || server.template || server.internal ? (
                    <ServerKindChips server={server} />
                  ) : undefined
                }
                details={[
                  { label: t("list.columns", { column: "status" }), value: <ServerStatusLine server={server} />, wide: true },
                  { label: t("list.columns", { column: "tools" }), value: <ServerTools server={server} /> },
                  {
                    label: t("list.columns", { column: "access" }),
                    value: <ServerAccess server={server} companyId={flags.companyId} />,
                  },
                ]}
                actions={showActions ? <ServerActions server={server} flags={flags} handlers={handlers} /> : undefined}
              />
            ))}
          </RowCards>
          <Table aria-label={t("title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content aria-label={t("title")}>
                <Table.Header>
                  <Table.Column isRowHeader>{t("list.columns", { column: "server" })}</Table.Column>
                  <Table.Column>{t("list.columns", { column: "status" })}</Table.Column>
                  <Table.Column>{t("list.columns", { column: "tools" })}</Table.Column>
                  <Table.Column>{t("list.columns", { column: "access" })}</Table.Column>
                  {showActions ? (
                    <Table.Column>
                      <span className="sr-only">{tCommon("actions")}</span>
                    </Table.Column>
                  ) : null}
                </Table.Header>
                <Table.Body>
                  {rows.map((server) => (
                    <Table.Row key={server.id} id={server.id}>
                      <Table.Cell>
                        <ServerName server={server} />
                      </Table.Cell>
                      <Table.Cell>
                        <ServerStatus server={server} />
                      </Table.Cell>
                      <Table.Cell>
                        <ServerTools server={server} />
                      </Table.Cell>
                      <Table.Cell>
                        <ServerAccess server={server} companyId={flags.companyId} />
                      </Table.Cell>
                      {showActions ? (
                        <Table.Cell>
                          <ServerActions server={server} flags={flags} handlers={handlers} />
                        </Table.Cell>
                      ) : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
      <p className="text-xs text-muted">{t("list.endpoint")}</p>
    </div>
  );
}
