import "server-only";
import prisma from "@/lib/db/prisma";
import { storedSelect, type StoredRow } from "@/lib/gateway/catalog/catalog-entries";
import { CATALOG_REFRESH_MS, getCatalogState, jevErrorOutdated } from "@/lib/gateway/catalog/catalog-state";
import { jevReady } from "@/lib/gateway/catalog/jev";
import { catalogStatus, splitTag, trustedKind } from "@/lib/gateway/catalog/model-catalog";
import { catalogRouting, getEnterprise } from "@/lib/settings/enterprise";
import type {
  CatalogEntryView,
  CatalogFamilyView,
  CatalogGroupView,
  CatalogSource,
  CatalogState,
  CatalogView,
  JevSettings,
} from "@/types/model-catalog";

const STATE_ORDER = { active: 0, disabled: 1, missing: 2 } as const;

function entryView(
  row: StoredRow,
  provider: { name: string; kind: string },
): CatalogEntryView {
  const source = row.source as CatalogSource;
  return {
    providerId: row.providerId,
    providerName: provider.name,
    kind: provider.kind,
    upstreamId: row.upstreamId,
    name: row.name,
    source,
    confidence: row.confidence,
    status: catalogStatus({ source, disabled: row.disabled }),
    trusted: trustedKind(provider.kind),
  };
}

function familiesOf(groups: CatalogGroupView[]): CatalogFamilyView[] {
  const byFamily = new Map<string, CatalogGroupView[]>();
  for (const group of groups) {
    const family = splitTag(group.alias).base;
    byFamily.set(family, [...(byFamily.get(family) ?? []), group]);
  }
  const families = [...byFamily].map(([family, variants]) => {
    variants.sort((a, b) => Number(Boolean(a.tag)) - Number(Boolean(b.tag)) || a.tag.localeCompare(b.tag));
    const lead = variants[0]!;
    return {
      family,
      vendor: variants.find((variant) => variant.vendor)?.vendor ?? "",
      displayName: lead.tag ? "" : lead.displayName,
      variants,
    };
  });
  const rank = (family: CatalogFamilyView) => Math.min(...family.variants.map((variant) => STATE_ORDER[variant.state]));
  return families.sort((a, b) => rank(a) - rank(b) || a.family.localeCompare(b.family));
}

async function withCurrentJev(state: CatalogState | null, settings: JevSettings | undefined) {
  if (!state || !jevErrorOutdated(state, settings)) return state;
  const { scheduleCatalogTask } = await import("@/lib/gateway/catalog/catalog-tasks");
  await scheduleCatalogTask({ task: "rebuild" });
  return { ...state, jev: { ...state.jev, error: "", configured: jevReady(settings) } };
}

export async function loadCatalogView(): Promise<Omit<CatalogView, "canManage" | "canConfigure">> {
  const [rows, providers, groups, state, enterprise] = await Promise.all([
    prisma.catalogEntry.findMany({ select: storedSelect }),
    prisma.providerConnection.findMany({ select: { id: true, name: true, kind: true } }),
    prisma.modelGroup.findMany({
      orderBy: { alias: "asc" },
      select: { alias: true, enabled: true, vendor: true, displayName: true, autoRoutes: true },
    }),
    getCatalogState(),
    getEnterprise(),
  ]);
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const views = new Map<string, CatalogGroupView>();
  for (const group of groups) {
    views.set(group.alias, {
      alias: group.alias,
      tag: splitTag(group.alias).tag,
      vendor: group.vendor,
      displayName: group.displayName,
      state: group.enabled ? "active" : "disabled",
      autoRoutes: group.autoRoutes,
      entries: [],
    });
  }
  for (const row of rows) {
    const provider = byId.get(row.providerId);
    if (!provider || !row.alias) continue;
    const view = views.get(row.alias) ?? {
      alias: row.alias,
      tag: splitTag(row.alias).tag,
      vendor: "",
      displayName: "",
      state: "missing" as const,
      autoRoutes: null,
      entries: [],
    };
    view.entries.push(entryView(row, provider));
    if (view.state === "missing") {
      view.vendor ||= row.vendor;
      view.displayName ||= row.name;
    }
    views.set(row.alias, view);
  }
  const list = [...views.values()];
  for (const view of list) {
    view.entries.sort(
      (a, b) =>
        Number(b.status === "active") - Number(a.status === "active") ||
        a.providerName.localeCompare(b.providerName) ||
        a.upstreamId.localeCompare(b.upstreamId),
    );
  }
  return {
    families: familiesOf(list),
    tags: [...new Set(list.map((view) => view.tag).filter(Boolean))].sort(),
    state: await withCurrentJev(state, enterprise.catalog_jev),
    refreshMs: CATALOG_REFRESH_MS,
    jevReady: jevReady(enterprise.catalog_jev),
    autoRoutesDefault: catalogRouting(enterprise).autoRoutes,
  };
}
