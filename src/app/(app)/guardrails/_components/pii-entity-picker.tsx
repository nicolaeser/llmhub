"use client";

import { Button, Card, Checkbox, Description, Label, Tag, TagGroup } from "@heroui/react";
import { useTranslations } from "next-intl";
import { PII_CATALOG } from "@/lib/gateway/pii";

function groupByCategory() {
  const map = new Map<string, typeof PII_CATALOG>();
  for (const e of PII_CATALOG) {
    const list = map.get(e.category) ?? [];
    list.push(e);
    map.set(e.category, list);
  }
  return [...map.entries()];
}

const GROUPED = groupByCategory();
const CATEGORIES = GROUPED.map(([category]) => category);

export default function PiiEntityPicker({
  value,
  onChange,
  isDisabled,
  wide,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  isDisabled?: boolean;
  wide?: boolean;
}) {
  const t = useTranslations("Guardrails");
  const groupKeys = GROUPED.filter(([, items]) => items.every((e) => value.includes(e.id))).map(
    ([category]) => category,
  );

  return (
    <Card variant="secondary" className="gap-4">
      <Card.Header className="flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <Card.Title>{t("entities")}</Card.Title>
          <Card.Description>{t("entitiesHint")}</Card.Description>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("selectAll")}
            isDisabled={isDisabled}
            onPress={() => onChange(PII_CATALOG.map((e) => e.id))}
          >
            {t("selectAll")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("selectNone")}
            isDisabled={isDisabled}
            onPress={() => onChange([])}
          >
            {t("selectNone")}
          </Button>
        </div>
      </Card.Header>
      <TagGroup
        selectionMode="multiple"
        selectedKeys={groupKeys}
        disabledKeys={isDisabled ? CATEGORIES : []}
        onSelectionChange={(keys) => {
          const picked = keys === "all" ? new Set(CATEGORIES) : new Set([...keys].map(String));
          const on = new Set(value);
          for (const [category, items] of GROUPED) {
            const full = items.every((e) => on.has(e.id));
            if (picked.has(category) === full) continue;
            for (const e of items) {
              if (full) on.delete(e.id);
              else on.add(e.id);
            }
          }
          onChange([...on]);
        }}
      >
        <Label>{t("groups")}</Label>
        <TagGroup.List>
          {GROUPED.map(([category, items]) => (
            <Tag key={category} id={category}>
              {t("groupTag", {
                label: t("categoryLabel", { category }),
                selected: items.filter((e) => value.includes(e.id)).length,
                total: items.length,
              })}
            </Tag>
          ))}
        </TagGroup.List>
        <Description>{t("groupsHint")}</Description>
      </TagGroup>
      {GROUPED.map(([category, items]) => (
        <div key={category}>
          <div className="mb-2 text-xs font-mono uppercase tracking-widest text-muted">
            {t("categoryLabel", { category })}
          </div>
          <ul className={wide ? "grid gap-2 sm:grid-cols-2 xl:grid-cols-3" : "grid gap-2 sm:grid-cols-2"}>
            {items.map((e) => {
              const label = t("entityLabel", { id: e.id });
              return (
                <li key={e.id}>
                  <Checkbox
                    isSelected={value.includes(e.id)}
                    isDisabled={isDisabled}
                    onChange={(on) =>
                      onChange(on ? [...value, e.id] : value.filter((id) => id !== e.id))
                    }
                    aria-label={label}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <Label>
                        {label}
                        <span className="ml-2 text-xs text-muted">{e.example}</span>
                      </Label>
                    </Checkbox.Content>
                  </Checkbox>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Card>
  );
}
