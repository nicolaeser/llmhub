"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Chip, Description, Label, NumberField, Spinner, Switch, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import { formats } from "@/i18n/formats";
import PageHeader from "@/components/console/page-header";
import SearchSelect from "@/components/console/search-select";
import { loadCacheAction, saveCacheAction } from "@/app/(app)/cache/_action";
import {
  CACHE_TTL_MAX_SECONDS,
  SEMANTIC_THRESHOLD_DEFAULT,
  SEMANTIC_THRESHOLD_MIN,
} from "@/lib/gateway/cache-settings";
import { isActionFail } from "@/lib/http/action-result";
import CacheStats from "./_components/cache-stats";
import type { CacheView, SemanticCacheSettings } from "@/types/cache";

const BACKEND_COLOR = { redis: "success", memory: "default", fallback: "warning" } as const;

export default function CachePage() {
  const t = useTranslations("Cache");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [view, setView] = useState<CacheView | null>(null);
  const [ttl, setTtl] = useState(0);
  const [semantic, setSemantic] = useState<SemanticCacheSettings | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    loadCacheAction().then((res) => {
      if (isActionFail(res)) return;
      setView(res);
      setTtl(res.cacheTtlSeconds);
      setSemantic(res.semantic);
    });
  }, []);

  if (!view || !semantic) {
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

  const disabled = !view.canManage;
  const update = (patch: Partial<SemanticCacheSettings>) => setSemantic({ ...semantic, ...patch });

  return (
    <div className="space-y-5">
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          view.canManage ? (
            <Button
              aria-label={t("save")}
              isPending={pending}
              onPress={() =>
                start(async () => {
                  const result = await saveCacheAction({ cacheTtlSeconds: ttl, semantic });
                  if (isActionFail(result)) {
                    toast.danger(tError("code", { code: result.error }));
                    return;
                  }
                  setView(result);
                  setTtl(result.cacheTtlSeconds);
                  setSemantic(result.semantic);
                  toast(t("saved"), { variant: "success" });
                })
              }
            >
              {({ isPending }) => (
                <>
                  {isPending ? <Spinner color="current" size="sm" /> : null}
                  {t("save")}
                </>
              )}
            </Button>
          ) : undefined
        }
      />
      {view.stats ? <CacheStats initial={view.stats} semanticOn={view.semantic.enabled} /> : null}
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("store.title")}</Card.Title>
          <Card.Description>{t("store.description")}</Card.Description>
        </Card.Header>
        <div className="flex flex-wrap items-center gap-2">
          <Chip size="sm" variant="soft" color={BACKEND_COLOR[view.backend]}>
            {t("store.backend", { backend: view.backend })}
          </Chip>
          <p className="text-xs text-muted">{t("store.backendHint", { backend: view.backend })}</p>
        </div>
        <NumberField
          fullWidth
          value={ttl}
          onChange={(value) => setTtl(Number.isFinite(value) ? value : 0)}
          minValue={0}
          maxValue={CACHE_TTL_MAX_SECONDS}
          step={1}
          formatOptions={formats.number.integer}
          isDisabled={disabled}
          className="max-w-md"
        >
          <Label>{t("ttl")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("ttlHint")}</Description>
        </NumberField>
      </Card>
      <Card className="gap-4">
        <Card.Header>
          <Card.Title>{t("semantic.title")}</Card.Title>
          <Card.Description>{t("semantic.description")}</Card.Description>
        </Card.Header>
        <Switch
          isSelected={semantic.enabled}
          onChange={(enabled) => update({ enabled })}
          isDisabled={disabled || !semantic.model}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>{t("semantic.enabled")}</Label>
          </Switch.Content>
          <Description>{t("semantic.enabledHint", { ready: semantic.model ? "true" : "false" })}</Description>
        </Switch>
        <SearchSelect
          label={t("semantic.model")}
          description={t("semantic.modelHint")}
          items={[
            { id: "none", label: t("semantic.none") },
            ...[...new Set([...view.aliases, ...(semantic.model ? [semantic.model] : [])])].map((alias) => ({
              id: alias,
              label: alias,
            })),
          ]}
          value={semantic.model || "none"}
          onChange={(key) => {
            const model = key === "none" ? "" : key;
            update({ model, enabled: model ? semantic.enabled : false });
          }}
          isDisabled={disabled}
          className="max-w-md"
        />
        <NumberField
          fullWidth
          value={semantic.threshold}
          onChange={(threshold) => update({ threshold: Number.isFinite(threshold) ? threshold : SEMANTIC_THRESHOLD_DEFAULT })}
          minValue={SEMANTIC_THRESHOLD_MIN}
          maxValue={1}
          step={0.01}
          formatOptions={formats.number.percent}
          isDisabled={disabled}
          className="max-w-xs"
        >
          <Label>{t("semantic.threshold")}</Label>
          <NumberField.Group>
            <NumberField.DecrementButton />
            <NumberField.Input />
            <NumberField.IncrementButton />
          </NumberField.Group>
          <Description>{t("semantic.thresholdHint")}</Description>
        </NumberField>
      </Card>
    </div>
  );
}
