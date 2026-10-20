"use client";

import { useRef, useState, useTransition } from "react";
import { Tabs, useOverlayState } from "@heroui/react";
import { HeartPulse, KeyRound, Plug, UserRound, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { LoadError, PageLoading, type LoadingShape } from "@/components/console/page-status";
import { useErrorToast } from "@/components/console/use-error-toast";
import ImportModelsDialog from "./_components/import-models-dialog";
import ProviderDialog from "./_components/provider-dialog";
import { isSignInKind } from "@/lib/gateway/upstreams/provider-kinds";
import { useActionData } from "@/lib/hooks/use-action-data";
import { useSearchParam } from "@/lib/hooks/use-search-param";
import { isActionFail } from "@/lib/http/action-result";
import type {
  ImportCandidate,
  ProviderKindSpec,
  ProviderListActions,
  ProvidersTab,
  ProviderView,
} from "@/types/providers";
import { discoverProviderAction, loadProvidersAction } from "./_action";
import ApiProviders from "./_components/api-providers";
import ProviderHealth from "./_components/provider-health";
import SubscriptionAccounts from "./_components/subscription-accounts";

const TABS = [
  { id: "api", icon: KeyRound },
  { id: "subscriptions", icon: UserRound },
  { id: "health", icon: HeartPulse },
] as const satisfies readonly { id: ProvidersTab; icon: LucideIcon }[];

function tabOf(value: unknown): ProvidersTab {
  return TABS.find((tab) => tab.id === value)?.id ?? "api";
}

export default function ProvidersPage() {
  const t = useTranslations("Providers");
  const showError = useErrorToast();
  const tabParam = useSearchParam("tab");
  const [picked, setPicked] = useState<ProvidersTab | null>(null);
  const [spec, setSpec] = useState<ProviderKindSpec | null>(null);
  const [edit, setEdit] = useState<ProviderView | null>(null);
  const [discover, setDiscover] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<ImportCandidate[] | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [, startDiscover] = useTransition();
  const afterSave = useRef<((provider: ProviderView) => void) | undefined>(undefined);
  const formState = useOverlayState();
  const discoverState = useOverlayState();
  const page = useActionData<ProviderView[]>(async () => {
    const res = await loadProvidersAction();
    return isActionFail(res) ? res : res.connected;
  });
  const { data: connected, setData: setConnected } = page;
  const tab = picked ?? tabOf(tabParam);

  function selectTab(next: ProvidersTab) {
    setPicked(next);
    window.history.replaceState(null, "", next === "api" ? window.location.pathname : `?tab=${next}`);
  }

  function replace(provider: ProviderView) {
    setConnected((cur) => cur.map((row) => (row.id === provider.id ? provider : row)));
  }

  function saved(provider: ProviderView, superseded: string[]) {
    setConnected((cur) => {
      const kept = cur.filter((row) => !superseded.includes(row.id));
      return kept.some((row) => row.id === provider.id)
        ? kept.map((row) => (row.id === provider.id ? provider : row))
        : [provider, ...kept];
    });
    afterSave.current?.(provider);
  }

  const actions: ProviderListActions = {
    openForm(next, row, onSaved) {
      setSpec(next);
      setEdit(row);
      afterSave.current = onSaved;
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
    upsert(providers) {
      const byId = new Map(providers.map((provider) => [provider.id, provider]));
      setConnected((cur) => [
        ...providers.filter((provider) => !cur.some((row) => row.id === provider.id)),
        ...cur.map((row) => byId.get(row.id) ?? row),
      ]);
    },
    remove(id) {
      setConnected((cur) => cur.filter((row) => row.id !== id));
    },
  };

  const status = (shape: LoadingShape) =>
    page.error === null ? <PageLoading {...shape} /> : <LoadError state={page} />;

  return (
    <div>
      <PageHeader icon={Plug} title={t("title")} subtitle={t("subtitle")} />

      {tabParam === undefined ? (
        <PageLoading tabs layout="cards" />
      ) : (
        <Tabs selectedKey={tab} onSelectionChange={(key) => selectTab(tabOf(key))} aria-label={t("tabsLabel")}>
          <Tabs.List className="w-full flex-wrap" aria-label={t("tabsLabel")}>
            {TABS.map(({ id, icon: Icon }) => (
              <Tabs.Tab key={id} id={id} className="w-auto shrink-0 gap-2 whitespace-nowrap">
                <Icon size={14} aria-hidden />
                {t("tabs", { tab: id })}
                <Tabs.Indicator />
              </Tabs.Tab>
            ))}
          </Tabs.List>

          <Tabs.Panel id="api" className="pt-4">
            {connected ? (
              <ApiProviders rows={connected.filter((row) => !isSignInKind(row.kind))} actions={actions} />
            ) : (
              status({ layout: "cards" })
            )}
          </Tabs.Panel>

          <Tabs.Panel id="subscriptions" className="pt-4">
            {connected ? (
              <SubscriptionAccounts rows={connected.filter((row) => isSignInKind(row.kind))} actions={actions} />
            ) : (
              status({ stats: 4, layout: "panels" })
            )}
          </Tabs.Panel>

          <Tabs.Panel id="health" className="pt-4">
            <ProviderHealth />
          </Tabs.Panel>
        </Tabs>
      )}

      <ProviderDialog key={`form-${dialogKey}`} state={formState} spec={spec} editing={edit} onSaved={saved} />

      <ImportModelsDialog
        key={`import-${dialogKey}`}
        state={discoverState}
        provider={discover}
        models={models}
        onImported={replace}
      />
    </div>
  );
}
