"use client";

import { buttonVariants, Card, Separator } from "@heroui/react";
import { CircleCheck, OctagonAlert, Plug, Wallet, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";
import type { OverviewAttention, Tone } from "@/types/console";

function attentionLook(item: OverviewAttention): { icon: LucideIcon; tone: Tone } {
  if (item.kind === "budget") return { icon: Wallet, tone: item.ratio >= 1 ? "danger" : "warning" };
  if (item.kind === "provider") return { icon: Plug, tone: item.cooling ? "danger" : "warning" };
  return { icon: OctagonAlert, tone: "danger" };
}

export default function AttentionList({ items }: { items: readonly OverviewAttention[] }) {
  const t = useTranslations("Overview.attention");

  function message(item: OverviewAttention) {
    if (item.kind === "budget") return t("budget", { target: item.target, name: item.name, ratio: item.ratio });
    if (item.kind === "provider") {
      return t("provider", { name: item.name, cooling: item.cooling ? "true" : "false", failures: item.failures });
    }
    return t("errors", { count: item.count });
  }

  return (
    <Card render={(props) => <section {...props} />} aria-label={t("title")} className="gap-4">
      <Card.Header>
        <Card.Title>{t("title")}</Card.Title>
        <Card.Description>{t("description")}</Card.Description>
      </Card.Header>
      <Card.Content>
        {items.length ? (
          <ul>
            {items.map((item, index) => {
              const look = attentionLook(item);
              return (
                <li key={item.id}>
                  {index > 0 ? <Separator /> : null}
                  <div className="flex items-center gap-3 py-2.5">
                    <IconTile icon={look.icon} tone={look.tone} size="sm" />
                    <p className="min-w-0 flex-1 text-sm break-words text-foreground">{message(item)}</p>
                    {item.href ? (
                      <Link href={item.href} className={buttonVariants({ size: "sm", variant: "ghost" })}>
                        {t("open")}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="flex items-center gap-3 py-1">
            <IconTile icon={CircleCheck} tone="success" size="sm" />
            <p className="text-sm text-muted">{t("empty")}</p>
          </div>
        )}
      </Card.Content>
    </Card>
  );
}
