"use client";

import { useState } from "react";
import { Button, Card, Chip, Disclosure } from "@heroui/react";
import { Plug, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import IconTile from "@/components/console/icon-tile";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { ProviderKindSpec, ProviderListActions, ProviderView } from "@/types/providers";
import { kindIcon } from "@/components/providers/kind-icons";
import ProviderCard from "./provider-card";

const STARTER_KINDS = new Set(["openai", "anthropic", "openrouter", "openai_compat"]);
const API_CATALOG = PROVIDER_CATALOG.filter((spec) => !isSignInKind(spec.kind));
const STARTER_CATALOG = API_CATALOG.filter((spec) => STARTER_KINDS.has(spec.kind));
const MORE_CATALOG = API_CATALOG.filter((spec) => !STARTER_KINDS.has(spec.kind));

export default function ApiProviders({ rows, actions }: { rows: ProviderView[]; actions: ProviderListActions }) {
  const t = useTranslations("Providers");
  const [browsing, setBrowsing] = useState(false);

  if (rows.length === 0 && !browsing) {
    return (
      <EmptyState
        icon={Plug}
        title={t("emptyTitle")}
        description={t("empty")}
        action={
          <Button aria-label={t("connect")} onPress={() => setBrowsing(true)}>
            {t("connect")}
          </Button>
        }
      />
    );
  }

  const catalog = rows.length > 0 ? API_CATALOG : STARTER_CATALOG;

  function catalogCard(spec: ProviderKindSpec) {
    const count = rows.filter((row) => row.kind === spec.kind).length;
    const name = t("kindName", { kind: spec.kind });
    return (
      <Card key={spec.kind}>
        <Card.Header className="flex-row items-start gap-3">
          <IconTile icon={kindIcon(spec.kind)} tone={count ? "accent" : "neutral"} />
          <div className="min-w-0 flex-1">
            <Card.Title>{name}</Card.Title>
            <Card.Description>{t("kindDescription", { kind: spec.kind })}</Card.Description>
          </div>
        </Card.Header>
        <Card.Footer className="mt-auto flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-muted">{count ? t("connectedCount", { count }) : null}</span>
          <Button
            size="sm"
            variant="secondary"
            aria-label={t("formTitle", { mode: "connect", name })}
            onPress={() => actions.openForm(spec, null)}
          >
            <Plus size={14} aria-hidden />
            {t("connect")}
          </Button>
        </Card.Footer>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {rows.length > 0 ? (
        <section className="space-y-3" aria-labelledby="providers-connected">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="providers-connected" className="text-base font-semibold tracking-tight">
              {t("connectedTitle")}
            </h2>
            <Chip size="sm" variant="soft">
              {rows.length}
            </Chip>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {rows.map((row) => (
              <ProviderCard
                key={row.id}
                row={row}
                onEdit={(provider) =>
                  actions.openForm(PROVIDER_CATALOG.find((spec) => spec.kind === provider.kind) ?? null, provider)
                }
                onImport={actions.openImport}
                onToggled={actions.replace}
                onDeleted={actions.remove}
              />
            ))}
          </div>
        </section>
      ) : null}

      <section className="space-y-3" aria-labelledby="providers-catalog">
        <div className="space-y-1">
          <h2 id="providers-catalog" className="text-base font-semibold tracking-tight">
            {t("catalogTitle")}
          </h2>
          <p className="text-sm text-muted">{t("catalogHint")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{catalog.map(catalogCard)}</div>
        {rows.length === 0 && MORE_CATALOG.length > 0 ? (
          <Disclosure>
            <Disclosure.Heading>
              <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
                {t("moreProviders")}
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body className="grid gap-3 pt-3 sm:grid-cols-2 xl:grid-cols-4">
                {MORE_CATALOG.map(catalogCard)}
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>
        ) : null}
      </section>
    </div>
  );
}
