"use client";

import { useState } from "react";
import { Card, ListBox, SearchField } from "@heroui/react";
import { Building2, Folder, KeyRound, User, Users, type LucideIcon } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import type { NodeKind, NodeRef, StructurePayload, TreeRow } from "@/types/structure";
import { nodeKey, parseNodeRef, treeHighlight, treeRows, usedRatio } from "./tree-model";

const ICONS: Record<NodeKind, LucideIcon> = {
  org: Building2,
  team: Users,
  project: Folder,
  member: User,
  key: KeyRound,
};
const INDENT = ["", "pl-5", "pl-10", "pl-15"] as const;

export default function CompanyTree({
  data,
  selected,
  onSelect,
}: {
  data: StructurePayload;
  selected: NodeRef | null;
  onSelect: (ref: NodeRef) => void;
}) {
  const t = useTranslations("Companies");
  const format = useFormatter();
  const [query, setQuery] = useState("");
  const rows = treeRows(data, query);
  const highlight = treeHighlight(data, selected, rows);
  const selectedKey = highlight?.exact ? highlight.key : null;

  function item(row: TreeRow) {
    const Icon = ICONS[row.kind];
    const ratio = usedRatio(row.budget);
    const key = nodeKey(row);
    const active = highlight?.key === key;
    return (
      <ListBox.Item key={key} id={key} textValue={row.alias}>
        <div className={`flex min-w-0 flex-1 items-center gap-2 ${INDENT[Math.min(row.depth, INDENT.length - 1)]}`}>
          <Icon size={14} aria-hidden className={`shrink-0 ${active ? "text-accent" : "text-muted"}`} />
          <span className={`min-w-0 break-words text-sm ${active ? "font-medium text-accent" : ""}`}>{row.alias}</span>
        </div>
        <span
          className={`shrink-0 text-xs tabular-nums ${ratio != null && ratio >= 1 ? "text-danger" : "text-muted"}`}
        >
          {ratio == null ? t("tree.unlimited") : format.number(ratio, "percent")}
        </span>
        <ListBox.ItemIndicator />
      </ListBox.Item>
    );
  }

  return (
    <Card className="gap-3">
      <Card.Header>
        <Card.Title>{t("tree.title", { scope: data.companyId ? "company" : "platform" })}</Card.Title>
      </Card.Header>
      <SearchField value={query} onChange={setQuery} aria-label={t("tree.search")}>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder={t("tree.search")} />
          <SearchField.ClearButton aria-label={t("tree.clear")} />
        </SearchField.Group>
      </SearchField>
      {rows.length === 0 ? (
        <p className="px-1 text-sm text-muted">{t("tree.noMatches")}</p>
      ) : (
        <div className="max-h-[45vh] overflow-y-auto lg:max-h-[60vh]">
          <ListBox
            aria-label={t("tree.title", { scope: data.companyId ? "company" : "platform" })}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={selectedKey ? [selectedKey] : []}
            onSelectionChange={(keys) => {
              if (keys === "all") return;
              const ref = parseNodeRef(String([...keys][0] ?? ""));
              if (ref) onSelect(ref);
            }}
          >
            {rows.map(item)}
          </ListBox>
        </div>
      )}
    </Card>
  );
}
