"use client";

import { useState, useTransition } from "react";
import { useOverlayState } from "@heroui/react";
import { Plug } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import PageStatus from "@/components/console/page-status";
import PageTabs from "@/components/console/page-tabs";
import { useErrorToast } from "@/components/console/use-error-toast";
import { isSignInKind, reportsLimits } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useTabParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type {
  AddProviderFilter,
  AddProviderPreset,
  AntigravityClientState,
  AuthFileSource,
  ImportCandidate,
  ProviderKindSpec,
  ProviderListActions,
  ProvidersPage,
  ProvidersTab,
  ProviderView,
} from "@/types/providers";
import type { PageTab } from "@/types/console";
import type { SubAddCreated } from "@/types/sub-add";
import { discoverProviderAction, loadAntigravityConfigAction, loadProvidersAction } from "./_action";
import AddProviderDialog from "./_components/add-provider-dialog";
import ApiProviders from "./_components/api-providers";
import AuthFilesDialog from "./_components/auth-files-dialog";
import ImportModelsDialog from "./_components/import-models-dialog";
import LinksDrawer, { useLinksDrawer, useSubAddLinks } from "./_components/links-drawer";
import ProviderDialog from "./_components/provider-dialog";
import ProviderHealth from "./_components/provider-health";
import { filterOf, poolTab, SUBSCRIPTION_CATALOG } from "./_components/provider-options";
import ProvidersToolbar from "./_components/providers-toolbar";
import SubAddDialog from "./_components/sub-add-dialog";
import SubscriptionAccounts from "./_components/subscription-accounts";
import { useAccountLimits } from "./_components/use-account-limits";

const TABS = ["api", "subscriptions", "health"] as const satisfies readonly ProvidersTab[];

const SUBSCRIPTION_KINDS = SUBSCRIPTION_CATALOG.map((spec) => spec.kind);

export default function ProvidersPage() {
  const t = useTranslations("Providers");
  const showError = useErrorToast();
  const [, selectTab] = useTabParam(TABS);
  const page = useActionData<ProvidersPage>(loadProvidersAction);
  const { data, setData } = page;
  const signInRows = data ? data.connected.filter((row) => isSignInKind(row.kind)) : null;
  const limits = useAccountLimits(signInRows, page.reload);
  const links = useSubAddLinks();
  const linksDrawer = useLinksDrawer();
  const antigravity = useActionData<AntigravityClientState>(loadAntigravityConfigAction);
  const [spec, setSpec] = useState<ProviderKindSpec | null>(null);
  const [edit, setEdit] = useState<ProviderView | null>(null);
  const [discover, setDiscover] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<ImportCandidate[] | null>(null);
  const [addPreset, setAddPreset] = useState<AddProviderPreset>({ kind: null, filter: "all" });
  const [importSource, setImportSource] = useState<AuthFileSource>("files");
  const [dialogKey, setDialogKey] = useState(0);
  const [, startDiscover] = useTransition();
  const formState = useOverlayState();
  const discoverState = useOverlayState();
  const addState = useOverlayState();
  const importState = useOverlayState();

  function setConnected(update: (current: ProviderView[]) => ProviderView[]) {
    setData((current) => ({ ...current, connected: update(current.connected) }));
  }

  function replace(provider: ProviderView) {
    setConnected((current) => current.map((row) => (row.id === provider.id ? provider : row)));
  }

  function remove(id: string) {
    setConnected((current) => current.filter((row) => row.id !== id));
  }

  function saved(provider: ProviderView, superseded: string[]) {
    setConnected((current) => {
      const kept = current.filter((row) => !superseded.includes(row.id));
      return kept.some((row) => row.id === provider.id)
        ? kept.map((row) => (row.id === provider.id ? provider : row))
        : [provider, ...kept];
    });
    if (reportsLimits(provider.kind)) limits.refreshOne(provider.id);
  }

  function connected(provider: ProviderView, superseded: string[]) {
    saved(provider, superseded);
    selectTab(poolTab(provider.kind));
  }

  function imported(providers: ProviderView[], superseded: string[]) {
    const byId = new Map(providers.map((provider) => [provider.id, provider]));
    setConnected((current) => [
      ...providers.filter((provider) => !current.some((row) => row.id === provider.id)),
      ...current.filter((row) => !superseded.includes(row.id)).map((row) => byId.get(row.id) ?? row),
    ]);
    limits.refreshAdded(providers);
    if (providers.length) selectTab("subscriptions");
  }

  function linkCreated(result: SubAddCreated) {
    links.page.setData((current) => ({ ...current, links: [result.link, ...current.links] }));
  }

  function openAdd(kind: string | null, filter: AddProviderFilter) {
    setAddPreset({ kind, filter: kind ? filterOf(kind) : filter });
    setDialogKey((n) => n + 1);
    addState.open();
  }

  function openImportFiles(source: AuthFileSource) {
    setImportSource(source);
    setDialogKey((n) => n + 1);
    importState.open();
  }

  const actions: ProviderListActions = {
    openForm(next, row) {
      setSpec(next);
      setEdit(row);
      setDialogKey((n) => n + 1);
      formState.open();
    },
    openImport(row) {
      setDiscover(row);
      setModels(null);
      setDialogKey((n) => n + 1);
      discoverState.open();
      startDiscover(async () => {
        const result = await discoverProviderAction(row.id);
        if (isActionFail(result)) {
          setModels([]);
          showError(result.error);
          return;
        }
        replace(result.provider);
        setModels(result.models);
      });
    },
    replace,
    remove,
  };

  if (!data) {
    return <PageStatus icon={Plug} title={t("title")} subtitle={t("subtitle")} state={page} tabs layout="table" />;
  }

  const { canManage } = data;
  const linkCount = links.page.data?.links.length ?? null;
  const antigravityState = antigravity.data;
  const antigravityReady = antigravityState === null ? null : antigravityState.saved || antigravityState.bundled;

  const tabs = [
    {
      id: "api",
      label: t("tabs", { tab: "api" }),
      panel: (
        <ApiProviders
          rows={data.connected.filter((row) => !isSignInKind(row.kind))}
          presets={data.presets}
          actions={actions}
          canManage={canManage}
          onAdd={() => openAdd(null, "api")}
        />
      ),
    },
    {
      id: "subscriptions",
      label: t("tabs", { tab: "subscriptions" }),
      panel: (
        <SubscriptionAccounts
          rows={signInRows ?? []}
          presets={data.presets}
          actions={actions}
          canManage={canManage}
          limits={limits}
          antigravity={antigravityState}
          onAntigravity={antigravity.setData}
          onAdd={(kind) => openAdd(kind, "subscription")}
          onCreateLink={links.openCreate}
          canSeeKeyUsage={data.canSeeKeyUsage}
          linkCount={linkCount}
          onOpenLinks={() => linksDrawer.setOpen(true)}
        />
      ),
    },
    { id: "health", label: t("tabs", { tab: "health" }), panel: <ProviderHealth /> },
  ] satisfies (PageTab & { id: ProvidersTab })[];

  return (
    <div>
      <PageHeader
        icon={Plug}
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <ProvidersToolbar
              linkCount={linkCount}
              onImport={() => openImportFiles("files")}
              onCreateLink={() => links.openCreate(null)}
              onOpenLinks={() => linksDrawer.setOpen(true)}
              onAdd={() => openAdd(null, "all")}
            />
          ) : undefined
        }
      />
      <PageTabs label={t("tabsLabel")} tabs={tabs} />
      <LinksDrawer
        links={links}
        open={linksDrawer.open}
        canManage={canManage}
        onOpenChange={linksDrawer.setOpen}
        onCreate={() => links.openCreate(null)}
      />

      {canManage ? (
        <>
          <AddProviderDialog
            key={`add-${dialogKey}`}
            state={addState}
            preset={addPreset}
            rows={data.connected}
            antigravity={antigravityState}
            onAntigravity={antigravity.setData}
            onImport={openImportFiles}
            onShare={links.openCreate}
            onSaved={connected}
          />
          <ProviderDialog key={`form-${dialogKey}`} state={formState} spec={spec} editing={edit} onSaved={saved} />
          <ImportModelsDialog
            key={`import-${dialogKey}`}
            state={discoverState}
            provider={discover}
            models={models}
            onImported={replace}
          />
          <AuthFilesDialog
            key={`files-${dialogKey}`}
            state={importState}
            initialSource={importSource}
            onImported={imported}
          />
          <SubAddDialog
            key={`sub-add-${links.dialogKey}`}
            state={links.dialogState}
            kinds={SUBSCRIPTION_KINDS}
            preset={links.preset}
            antigravityReady={antigravityReady}
            onCreated={linkCreated}
          />
        </>
      ) : null}
    </div>
  );
}
