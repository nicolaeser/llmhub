"use client";

import { buttonVariants, Card } from "@heroui/react";
import { ArrowRight, Building2, KeyRound, Network, Shield, type LucideIcon } from "lucide-react";
import { useId } from "react";
import { useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";
import type { OverviewConcept } from "@/types/console";

const ICONS: Record<OverviewConcept, LucideIcon> = {
  company: Building2,
  key: KeyRound,
  preset: Network,
  guardrail: Shield,
};

export default function ConceptCards({ concepts }: { concepts: readonly { id: OverviewConcept; href: string | null }[] }) {
  const t = useTranslations("Overview.concepts");
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <div>
        <h2 id={headingId} className="text-base font-semibold tracking-tight text-foreground">
          {t("title")}
        </h2>
        <p className="text-sm text-muted">{t("description")}</p>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {concepts.map((concept) => (
          <li key={concept.id} className="flex">
            <Card className="w-full gap-3">
              <IconTile icon={ICONS[concept.id]} size="sm" />
              <Card.Header className="gap-1">
                <Card.Title>{t(`${concept.id}.title`)}</Card.Title>
                <Card.Description>{t(`${concept.id}.body`)}</Card.Description>
              </Card.Header>
              {concept.href ? (
                <Card.Footer className="mt-auto">
                  <Link
                    href={concept.href}
                    aria-label={t("openNamed", { name: t(`${concept.id}.title`) })}
                    className={buttonVariants({ size: "sm", variant: "ghost" })}
                  >
                    {t("open")}
                    <ArrowRight size={14} aria-hidden />
                  </Link>
                </Card.Footer>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
