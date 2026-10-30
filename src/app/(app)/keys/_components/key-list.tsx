"use client";

import { useMemo, useState } from "react";
import { Chip, ListBox, Meter, SearchField, Select, Table } from "@heroui/react";
import { KeyRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import RowCard, { RowCards, TABLE_FROM_LG } from "@/components/console/row-cards";
import { bindingKind, placeOf } from "@/components/keys/key-binding";
import KeyMenu, { hasKeyMenu, keyMenuActions, type KeyMenuAction, type KeyMenuFlags } from "./key-menu";
import KeyStateChip from "@/components/keys/key-state-chip";
import { Link, useRouter } from "@/i18n/routing";
import { accessSummary } from "@/lib/keys/draft";
import { isKeyPaused, keyState, type KeyState } from "@/lib/keys/pause";
import { meterColor } from "@/lib/utils/budget";
import type { KeyBindingKind, KeyOptions, VirtualKeyView } from "@/types/keys";

const ALL = "all";
const STATES: KeyState[] = ["active", "paused", "blocked"];
const KINDS: KeyBindingKind[] = ["project", "member", "internal"];

type FilterOption = { id: string; label: string };

function FilterSelect({
  label,
  value,
  options,
  wide = false,
  onChange,
}: {
  label: string;
  value: string;
  options: FilterOption[];
  wide?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Select
      className={wide ? "col-span-2 w-full sm:w-44" : "w-full sm:w-44"}
      selectedKey={value}
      onSelectionChange={(key) => onChange(String(key ?? ALL))}
      aria-label={label}
    >
      <Select.Trigger>
        <Select.Value />
        <Select.Indicator />
      </Select.Trigger>
      <Select.Popover>
        <ListBox aria-label={label}>
          {options.map((option) => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
              {option.label}
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Select.Popover>
    </Select>
  );
}

export default function KeyList({
  keys,
  options,
  owners,
  flags,
  now,
  busyId,
  lockedId,
  onAction,
}: {
  keys: VirtualKeyView[];
  options: KeyOptions;
  owners: Record<string, string>;
  flags: KeyMenuFlags;
  now: Date;
  busyId: string | null;
  lockedId: string | null;
  onAction: (row: VirtualKeyView, action: KeyMenuAction) => void;
}) {
  const t = useTranslations("Keys");
  const tCommon = useTranslations("Common");
  const format = useFormatter();
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState(ALL);
  const [kind, setKind] = useState(ALL);
  const [company, setCompany] = useState(ALL);
  const hasActions = hasKeyMenu(flags);
  const showCompany = !options.companyId && options.orgs.length > 1;
  const byId = useMemo(() => new Map(keys.map((row) => [row.token_id, row])), [keys]);

  function stateOf(row: VirtualKeyView) {
    return keyState({ blocked: row.blocked, paused: row.paused, pausedUntil: row.paused_until }, now);
  }

  const filtered = keys.filter((row) => {
    const q = query.trim().toLowerCase();
    if (status !== ALL && stateOf(row) !== status) return false;
    if (kind !== ALL && bindingKind(row) !== kind) return false;
    if (company !== ALL && row.org_id !== company) return false;
    if (!q) return true;
    return [row.key_alias, row.key_name, row.token_id, ownerOf(row).name].some((value) =>
      value.toLowerCase().includes(q),
    );
  });
  const filtering = Boolean(query.trim()) || status !== ALL || kind !== ALL || company !== ALL;

  function ownerOf(row: VirtualKeyView) {
    const bound = bindingKind(row);
    const target =
      bound === "project"
        ? options.projects.find((item) => item.id === row.project_id)
        : bound === "member"
          ? options.members.find((item) => item.id === row.member_id)
          : undefined;
    const place = placeOf(options, row.org_id, row.team_id);
    return {
      kind: bound,
      name: target?.alias ?? (bound === "internal" ? (owners[row.user_id] ?? "") : ""),
      path: t("binding.path", {
        kind: bound,
        hasPlace: place.org ? "yes" : "no",
        place: t("binding.place", { org: place.org, team: place.team, hasTeam: place.team ? "yes" : "no" }),
      }),
    };
  }

  function accessLabel(row: VirtualKeyView) {
    const summary = accessSummary({ models: row.models, templateIds: row.templates }, options.templates);
    if (summary.state === "all") return t("allModels");
    const names = options.templates.filter((template) => row.templates.includes(template.id)).map((template) => template.name);
    return format.list(row.models.length ? [...names, t("modelCount", { count: row.models.length })] : names, {
      type: "unit",
    });
  }

  function ownerValue(row: VirtualKeyView) {
    const owner = ownerOf(row);
    return (
      <span className="block min-w-0">
        <span className="block text-sm break-words text-foreground">{owner.name || tCommon("none")}</span>
        <span className="block text-xs text-muted">{owner.path}</span>
      </span>
    );
  }

  function spendValue(row: VirtualKeyView) {
    const label = tCommon("spendBudget", {
      hasCap: row.max_budget > 0 ? "yes" : "no",
      spend: row.spend,
      budget: row.max_budget,
    });
    if (!(row.max_budget > 0)) return <span className="text-sm tabular-nums">{label}</span>;
    const ratio = Math.min(1, row.spend / row.max_budget);
    return (
      <span className="block min-w-0 space-y-1.5">
        <span className="block text-sm tabular-nums">{label}</span>
        <Meter size="sm" value={ratio * 100} color={meterColor(ratio)} aria-label={t("columns.spend")}>
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      </span>
    );
  }

  function keyChips(row: VirtualKeyView) {
    return (
      <>
        <KeyStateChip state={stateOf(row)} pausedUntil={row.paused_until} />
        {row.log_content ? null : (
          <Chip size="sm" variant="soft" color="warning">
            {t("contentOff")}
          </Chip>
        )}
        {row.allowed_endpoints.length || row.allowed_ips.length || row.access_windows.length ? (
          <Chip size="sm" variant="soft">
            {t("restrictedChip")}
          </Chip>
        ) : null}
      </>
    );
  }

  function keyName(row: VirtualKeyView) {
    return (
      <Link href={`/keys/${row.token_id}`} className="font-medium text-accent">
        {row.key_alias || row.key_name}
      </Link>
    );
  }

  function keyMenu(row: VirtualKeyView) {
    if (!hasActions) return null;
    return (
      <KeyMenu
        name={row.key_alias || row.key_name}
        actions={keyMenuActions(flags, {
          capped: row.max_budget > 0,
          paused: isKeyPaused({ paused: row.paused, pausedUntil: row.paused_until }, now),
        })}
        pending={busyId === row.token_id}
        isDisabled={lockedId !== null && lockedId !== row.token_id}
        onAction={(action) => onAction(row, action)}
      />
    );
  }

  const stateOptions = [
    { id: ALL, label: t("filters.allStates") },
    ...STATES.map((state) => ({ id: state, label: t("state", { state, timed: "no", until: "" }) })),
  ];
  const kindOptions = [
    { id: ALL, label: t("filters.allOwners") },
    ...KINDS.map((item) => ({ id: item, label: t("binding.kind", { kind: item }) })),
  ];
  const companyOptions = [
    { id: ALL, label: t("filters.allCompanies") },
    ...options.orgs.map((org) => ({ id: org.id, label: org.alias })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchField value={query} onChange={setQuery} aria-label={t("searchPlaceholder")} className="w-full sm:max-w-xs">
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={t("searchPlaceholder")} />
            <SearchField.ClearButton aria-label={tCommon("close")} />
          </SearchField.Group>
        </SearchField>
        <div className="grid w-full grid-cols-2 gap-3 sm:flex sm:w-auto sm:flex-wrap sm:items-center">
          <FilterSelect label={t("filters.status")} value={status} options={stateOptions} onChange={setStatus} />
          <FilterSelect label={t("filters.owner")} value={kind} options={kindOptions} onChange={setKind} />
          {showCompany ? (
            <FilterSelect
              wide
              label={t("filters.company")}
              value={company}
              options={companyOptions}
              onChange={setCompany}
            />
          ) : null}
        </div>
        {filtering ? (
          <p className="text-sm text-muted tabular-nums sm:ml-auto">
            {t("filters.shown", { count: filtered.length, total: keys.length })}
          </p>
        ) : null}
      </div>
      {filtered.length === 0 ? (
        <EmptyState icon={KeyRound} title={t("noMatches")} description={t("noMatchesHint")} />
      ) : (
        <>
          <RowCards label={t("title")}>
            {filtered.map((row) => (
              <RowCard
                key={row.token_id}
                title={keyName(row)}
                description={<span className="font-mono text-xs">{row.key_name}…</span>}
                aside={keyMenu(row) ?? undefined}
                chips={keyChips(row)}
                details={[
                  { label: t("columns.binding"), value: ownerValue(row), wide: true },
                  { label: t("columns.access"), value: accessLabel(row) },
                  { label: t("columns.spend"), value: spendValue(row) },
                ]}
              />
            ))}
          </RowCards>
          <Table aria-label={t("title")} className={TABLE_FROM_LG}>
            <Table.ScrollContainer>
              <Table.Content
                aria-label={t("title")}
                onRowAction={(id) => {
                  if (byId.has(String(id))) router.push(`/keys/${String(id)}`);
                }}
              >
                <Table.Header>
                  <Table.Column isRowHeader>{t("columns.name")}</Table.Column>
                  <Table.Column>{t("columns.binding")}</Table.Column>
                  <Table.Column>{t("columns.access")}</Table.Column>
                  <Table.Column>{t("columns.spend")}</Table.Column>
                  <Table.Column>{t("columns.status")}</Table.Column>
                  {hasActions ? <Table.Column>{tCommon("actions")}</Table.Column> : null}
                </Table.Header>
                <Table.Body>
                  {filtered.map((row) => (
                    <Table.Row key={row.token_id} id={row.token_id}>
                      <Table.Cell>
                        <div className="min-w-0">
                          {keyName(row)}
                          <div className="font-mono text-xs text-muted">{row.key_name}…</div>
                        </div>
                      </Table.Cell>
                      <Table.Cell>{ownerValue(row)}</Table.Cell>
                      <Table.Cell>
                        <span className="text-sm">{accessLabel(row)}</span>
                      </Table.Cell>
                      <Table.Cell>{spendValue(row)}</Table.Cell>
                      <Table.Cell>
                        <div className="flex flex-wrap gap-1">{keyChips(row)}</div>
                      </Table.Cell>
                      {hasActions ? <Table.Cell>{keyMenu(row)}</Table.Cell> : null}
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
        </>
      )}
    </div>
  );
}
