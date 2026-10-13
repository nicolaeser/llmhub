"use client";

import { useRef, useState, useTransition } from "react";
import { Tabs, useOverlayState } from "@heroui/react";
import { HeartPulse, KeyRound, Plug, UserRound, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { LoadError, PageLoading } from "@/components/console/page-status";
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

  function saved(provider: ProviderView) {
    setConnected((cur) =>
      cur.some((row) => row.id === provider.id)
        ? cur.map((row) => (row.id === provider.id ? provider : row))
        : [provider, ...cur],
    );
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
    remove(id) {
      setConnected((cur) => cur.filter((row) => row.id !== id));
    },
  };

  const status = page.error === null ? <PageLoading /> : <LoadError state={page} />;

  return (
    <div>
      <PageHeader icon={Plug} title={t("title")} subtitle={t("subtitle")} />

      {tabParam === undefined ? (
        <PageLoading />
      ) : (
        <Tabs selectedKey={tab} onSelectionChange={(key) => selectTab(tabOf(key))} aria-label={t("tabsLabel")}>
          <Tabs.ListContainer className="w-fit max-w-full">
            <Tabs.List aria-label={t("tabsLabel")}>
              {TABS.map(({ id, icon: Icon }) => (
                <Tabs.Tab key={id} id={id} className="gap-2 whitespace-nowrap">
                  <Icon size={14} aria-hidden />
                  {t("tabs", { tab: id })}
                  <Tabs.Indicator />
                </Tabs.Tab>
              ))}
            </Tabs.List>
          </Tabs.ListContainer>
  
          <Tabs.Panel id="api">
            {connected ? (
              <ApiProviders rows={connected.filter((row) => !isSignInKind(row.kind))} actions={actions} />
            ) : (
              status
            )}
          </Tabs.Panel>
  
          <Tabs.Panel id="subscriptions">
            {connected ? (
              <SubscriptionAccounts rows={connected.filter((row) => isSignInKind(row.kind))} actions={actions} />
            ) : (
              status
            )}
          </Tabs.Panel>
  
          <Tabs.Panel id="health">
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
