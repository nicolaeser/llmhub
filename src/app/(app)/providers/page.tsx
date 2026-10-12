"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  Chip,
  Disclosure,
  Spinner,
  toast,
  useOverlayState,
} from "@heroui/react";
import { Plug, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import EmptyState from "@/components/console/empty-state";
import PageHeader from "@/components/console/page-header";
import ImportModelsDialog from "@/components/providers/import-models-dialog";
import ProviderCard from "./_components/provider-card";
import ProviderDialog from "@/components/providers/provider-dialog";
import { isSignInKind, PROVIDER_CATALOG } from "@/lib/gateway/catalog";
import { discoverProviderAction, loadProvidersAction } from "@/app/(app)/providers/_action";
import { isActionFail } from "@/lib/http/action-result";
import type { ImportCandidate, ProviderView } from "@/types/providers";

const STARTER_KINDS = new Set(["openai", "anthropic", "openrouter", "openai_compat"]);
const API_CATALOG = PROVIDER_CATALOG.filter((spec) => !isSignInKind(spec.kind));
const STARTER_CATALOG = API_CATALOG.filter((spec) => STARTER_KINDS.has(spec.kind));
const MORE_CATALOG = API_CATALOG.filter((spec) => !STARTER_KINDS.has(spec.kind));

export default function ProvidersPage() {
  const t = useTranslations("Providers");
  const tCommon = useTranslations("Common");
  const tError = useTranslations("Error");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState<ProviderView[]>([]);
  const [kind, setKind] = useState<(typeof PROVIDER_CATALOG)[number] | null>(null);
  const [edit, setEdit] = useState<ProviderView | null>(null);
  const [discover, setDiscover] = useState<ProviderView | null>(null);
  const [models, setModels] = useState<ImportCandidate[] | null>(null);
  const [dialogKey, setDialogKey] = useState(0);
  const [browseCatalog, setBrowseCatalog] = useState(false);
  const [, startDiscover] = useTransition();
  const formState = useOverlayState();
  const discoverState = useOverlayState();

  useEffect(() => {
    loadProvidersAction().then((res) => {
      if (!isActionFail(res)) setConnected(res.connected.filter((row) => !isSignInKind(row.kind)));
      setLoading(false);
    });
  }, []);

  function replaceProvider(provider: ProviderView) {
    setConnected((cur) => cur.map((row) => (row.id === provider.id ? provider : row)));
  }

  function openForm(spec: (typeof PROVIDER_CATALOG)[number] | null, row: ProviderView | null) {
    setKind(spec);
    setEdit(row);
    setDialogKey((n) => n + 1);
    formState.open();
  }

  function openImport(row: ProviderView) {
    setDiscover(row);
    setModels(null);
    setDialogKey((n) => n + 1);
    discoverState.open();
    startDiscover(async () => {
      const result = await discoverProviderAction(row.id);
      if (isActionFail(result)) {
        setModels([]);
        toast.danger(tError("code", { code: result.error }));
        return;
      }
      replaceProvider(result.provider);
      setModels(result.models);
    });
  }

  if (loading) {
    return (
      <output
        aria-live="polite"
        aria-label={tCommon("loading")}
        className="flex min-h-[40vh] items-center justify-center text-accent"
      >
        <Spinner color="current" size="lg" />
      </output>
    );
  }

  const catalog = connected.length > 0 ? API_CATALOG : STARTER_CATALOG;
  const showCatalog = connected.length > 0 || browseCatalog;

  return (
    <div>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />

      {!showCatalog ? (
        <EmptyState
          icon={Plug}
          title={t("emptyTitle")}
          description={t("empty")}
          action={
            <Button
              aria-label={t("connect")}
              onPress={() => setBrowseCatalog(true)}
            >
              {t("connect")}
            </Button>
          }
        />
      ) : (
        <>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {catalog.map((spec) => {
          const items = connected.filter((c) => c.kind === spec.kind);
          return (
            <Card key={spec.kind}>
              <Card.Header>
                <div className="flex items-center justify-between gap-2">
                  <Card.Title>{t("kindName", { kind: spec.kind })}</Card.Title>
                  <Chip size="sm" variant="soft">
                    {t("connectedCount", { count: items.length })}
                  </Chip>
                </div>
                <Card.Description>
                  {t("kindDescription", { kind: spec.kind })}
                </Card.Description>
              </Card.Header>
              <Card.Content className="space-y-2">
                {items.map((row) => (
                  <ProviderCard
                    key={row.id}
                    row={row}
                    onEdit={(provider) =>
                      openForm(PROVIDER_CATALOG.find((k) => k.kind === provider.kind) ?? null, provider)
                    }
                    onImport={openImport}
                    onToggled={replaceProvider}
                    onDeleted={(id) => setConnected((cur) => cur.filter((c) => c.id !== id))}
                  />
                ))}
              </Card.Content>
              <Card.Footer>
                <Button
                  size="sm"
                  variant={items.length ? "secondary" : undefined}
                  aria-label={t("formTitle", {
                    mode: "connect",
                    name: t("kindName", { kind: spec.kind }),
                  })}
                  onPress={() => openForm(spec, null)}
                >
                  <Plus size={14} aria-hidden />
                  {t("connect")}
                </Button>
              </Card.Footer>
            </Card>
          );
        })}
      </div>
      {connected.length === 0 && MORE_CATALOG.length > 0 ? (
        <Disclosure className="mt-5">
          <Disclosure.Heading>
            <Disclosure.Trigger className="flex w-full items-center justify-between text-sm text-muted">
              {t("moreProviders")}
              <Disclosure.Indicator />
            </Disclosure.Trigger>
          </Disclosure.Heading>
          <Disclosure.Content>
            <Disclosure.Body className="pt-3">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {MORE_CATALOG.map((spec) => (
                  <Card key={spec.kind}>
                    <Card.Header>
                      <Card.Title>{t("kindName", { kind: spec.kind })}</Card.Title>
                      <Card.Description>
                        {t("kindDescription", { kind: spec.kind })}
                      </Card.Description>
                    </Card.Header>
                    <Card.Footer>
                      <Button
                        size="sm"
                        aria-label={t("formTitle", {
                          mode: "connect",
                          name: t("kindName", { kind: spec.kind }),
                        })}
                        onPress={() => openForm(spec, null)}
                      >
                        <Plus size={14} aria-hidden />
                        {t("connect")}
                      </Button>
                    </Card.Footer>
                  </Card>
                ))}
              </div>
            </Disclosure.Body>
          </Disclosure.Content>
        </Disclosure>
      ) : null}
        </>
      )}

      <ProviderDialog
        key={`form-${dialogKey}`}
        state={formState}
        spec={kind}
        editing={edit}
        onSaved={(provider) =>
          setConnected((cur) =>
            cur.some((row) => row.id === provider.id)
              ? cur.map((row) => (row.id === provider.id ? provider : row))
              : [provider, ...cur],
          )
        }
      />

      <ImportModelsDialog
        key={`import-${dialogKey}`}
        state={discoverState}
        provider={discover}
        models={models}
        onImported={replaceProvider}
      />
    </div>
  );
}
