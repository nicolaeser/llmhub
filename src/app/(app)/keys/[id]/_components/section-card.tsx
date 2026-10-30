"use client";

import type { ReactNode } from "react";
import { Button, Card } from "@heroui/react";
import { Pencil } from "lucide-react";
import { useTranslations } from "next-intl";

export type Fact = { label: string; value: ReactNode; wide?: boolean };

export function Facts({ items }: { items: Fact[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className={item.wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
          <dt className="text-xs text-muted">{item.label}</dt>
          <dd className="mt-0.5 text-sm break-words text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function SectionCard({
  title,
  description,
  editLabel,
  onEdit,
  action,
  children,
}: {
  title: string;
  description?: ReactNode;
  editLabel?: string;
  onEdit?: () => void;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTranslations("Common");
  return (
    <Card>
      <Card.Header className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          <Card.Title>{title}</Card.Title>
          {description ? <Card.Description>{description}</Card.Description> : null}
        </div>
        {onEdit || action ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {action}
            {onEdit ? (
              <Button size="sm" variant="secondary" onPress={onEdit} aria-label={editLabel}>
                <Pencil size={14} aria-hidden />
                {t("edit")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </Card.Header>
      {children ? <Card.Content>{children}</Card.Content> : null}
    </Card>
  );
}
