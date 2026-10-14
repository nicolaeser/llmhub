"use client";

import { useTranslations } from "next-intl";
import SearchSelect from "@/components/console/search-select";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import type { DeploymentDraft, ProviderOpt } from "@/types/models";

export default function ProviderSelect({
  dep,
  providers,
  withCatalog,
  isDisabled,
  onChange,
}: {
  dep: DeploymentDraft;
  providers: ProviderOpt[];
  withCatalog: boolean;
  isDisabled: boolean;
  onChange: (patch: Partial<DeploymentDraft>) => void;
}) {
  const t = useTranslations("Models");
  const tProviders = useTranslations("Providers");
  const value = dep.providerId || (dep.kind ? `kind:${dep.kind}` : "none");
  const kinds = PROVIDER_CATALOG.filter(
    (k) => `kind:${k.kind}` === value || (withCatalog && !providers.some((p) => p.kind === k.kind)),
  );
  function detail(kind: string) {
    return isSignInKind(kind)
      ? tProviders("poolDetail", { pool: "subscription", channel: tProviders("channel", { kind }) })
      : tProviders("kindName", { kind });
  }
  return (
    <SearchSelect
      label={t("fields.provider")}
      items={[
        { id: "none", label: t("fields.noProvider") },
        ...providers.map((p) => ({ id: p.id, label: p.name, detail: detail(p.kind) })),
        ...kinds.map((k) => ({
          id: `kind:${k.kind}`,
          label: isSignInKind(k.kind) ? tProviders("kindShort", { kind: k.kind }) : tProviders("kindName", { kind: k.kind }),
          detail: isSignInKind(k.kind) ? detail(k.kind) : undefined,
        })),
      ]}
      value={value}
      onChange={(raw) => {
        if (raw === "none") {
          onChange({ providerId: "", kind: "openai_compat" });
          return;
        }
        if (raw.startsWith("kind:")) {
          const nextKind = raw.slice(5);
          const spec = PROVIDER_CATALOG.find((k) => k.kind === nextKind);
          onChange({
            providerId: "",
            kind: nextKind,
            baseUrl: spec?.default_base_url || "",
          });
          return;
        }
        const p = providers.find((x) => x.id === raw);
        onChange({
          providerId: raw,
          kind: p?.kind || dep.kind,
          baseUrl: p?.baseUrl || dep.baseUrl,
        });
      }}
      isDisabled={isDisabled}
    />
  );
}
