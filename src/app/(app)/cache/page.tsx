"use client";

import { useEffect, useState, useTransition } from "react";
import { Button, Card, Description, Input, Label, Spinner, TextField, toast } from "@heroui/react";
import { useTranslations } from "next-intl";
import PageHeader from "@/components/console/page-header";
import { loadCacheAction, saveCacheAction } from "@/app/(app)/cache/_action";
import { isActionFail } from "@/lib/http/action-result";

export default function CachePage() {
  const t = useTranslations("Cache");
  const tError = useTranslations("Error");
  const tCommon = useTranslations("Common");
  const [loading, setLoading] = useState(true);
  const [ttl, setTtl] = useState("0");
  const [canManage, setCanManage] = useState(false);
  const [pending, start] = useTransition();

  useEffect(() => {
    loadCacheAction().then((res) => {
      if (!isActionFail(res)) {
        setTtl(String(res.cacheTtlSeconds ?? 0));
        setCanManage(res.canManage);
      }
      setLoading(false);
    });
  }, []);

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

  return (
    <div>
      <PageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <Button
              aria-label={t("save")}
              isPending={pending}
              onPress={() =>
                start(async () => {
                  const result = await saveCacheAction({ cacheTtlSeconds: Number(ttl) || 0 });
                  if (isActionFail(result)) {
                    toast.danger(tError("code", { code: result.error }));
                    return;
                  }
                  setTtl(String(result.cacheTtlSeconds));
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
      <Card>
        <TextField
          fullWidth
          value={ttl}
          onChange={setTtl}
          isDisabled={!canManage}
          className="max-w-md"
        >
          <Label>{t("ttl")}</Label>
          <Input inputMode="numeric" />
          <Description>{t("ttlHint")}</Description>
        </TextField>
      </Card>
    </div>
  );
}
