export type CatalogSource = "route" | "manual" | "rule" | "jev" | "";

export type CatalogStatus = "active" | "new" | "disabled";

export type CatalogGroupState = "active" | "disabled" | "missing";

export type CatalogModelInput = {
  id: string;
  name: string;
};

export type CatalogProviderInput = {
  id: string;
  kind: string;
  models: CatalogModelInput[];
};

export type CatalogGroupInput = {
  alias: string;
  vendor: string;
  displayName: string;
  autoRoutes: boolean | null;
};

export type CatalogRouteInput = {
  providerId: string;
  model: string;
  groupAlias: string;
};

export type StoredCatalogEntry = {
  providerId: string;
  upstreamId: string;
  alias: string;
  source: string;
  confidence: number;
  disabled: boolean;
  classifiedAt: Date | null;
};

export type CatalogEntryPlan = {
  providerId: string;
  upstreamId: string;
  kind: string;
  name: string;
  vendor: string;
  alias: string;
  source: CatalogSource;
  confidence: number;
  disabled: boolean;
  classifiedAt: Date | null;
  trusted: boolean;
  fresh: boolean;
};

export type JevCandidate = {
  alias: string;
  label: string;
};

export type JevTask = {
  providerId: string;
  upstreamId: string;
  kind: string;
  vendor: string;
  name: string;
  candidates: JevCandidate[];
};

export type CatalogPlan = {
  entries: CatalogEntryPlan[];
  jev: JevTask[];
};

export type JevVerdict = {
  alias: string;
  confidence: number;
};

export type CatalogProviderFailure = {
  providerId: string;
  name: string;
  code: string;
};

export type CatalogState = {
  refreshedAt: string;
  durationMs: number;
  providers: number;
  failed: CatalogProviderFailure[];
  entries: number;
  autoRouted: number;
  jev: {
    configured: boolean;
    asked: number;
    matched: number;
    pending: number;
    cost: number;
    error: string;
  };
};

export type CatalogEntryView = {
  providerId: string;
  providerName: string;
  kind: string;
  upstreamId: string;
  name: string;
  source: CatalogSource;
  confidence: number;
  status: CatalogStatus;
  trusted: boolean;
};

export type CatalogGroupView = {
  alias: string;
  tag: string;
  vendor: string;
  displayName: string;
  state: CatalogGroupState;
  autoRoutes: boolean | null;
  entries: CatalogEntryView[];
};

export type CatalogFamilyView = {
  family: string;
  vendor: string;
  displayName: string;
  variants: CatalogGroupView[];
};

export type CatalogView = {
  families: CatalogFamilyView[];
  tags: string[];
  state: CatalogState | null;
  refreshMs: number;
  jevReady: boolean;
  autoRoutesDefault: boolean;
  canManage: boolean;
};
