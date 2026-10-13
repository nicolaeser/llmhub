"use client";

import type { ReactNode } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LoadStatus } from "@/types/actions";
import PageHeader from "./page-header";

export function PageLoading() {
  const t = useTranslations("Common");
  return (
    <output
      aria-live="polite"
      aria-label={t("loading")}
      className="flex min-h-[40vh] items-center justify-center text-accent"
    >
      <Spinner color="current" size="lg" />
    </output>
  );
}

export function LoadError({ state, className }: { state: LoadStatus; className?: string }) {
  const t = useTranslations("Common");
  const tError = useTranslations("Error");
  if (state.error === null) return null;
  return (
    <Alert status="danger" className={className}>
      <Alert.Indicator />
      <Alert.Content>
        <Alert.Title>{t("loadFailed")}</Alert.Title>
        <Alert.Description>{tError("code", { code: state.error })}</Alert.Description>
      </Alert.Content>
      <Button size="sm" variant="danger-soft" isPending={state.pending} onPress={() => state.reload()}>
        {({ isPending }) => (
          <>
            {isPending ? <Spinner color="current" size="sm" /> : <RotateCcw size={14} aria-hidden />}
            {t("retry")}
          </>
        )}
      </Button>
    </Alert>
  );
}

export default function PageStatus({
  title,
  subtitle,
  state,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  state: LoadStatus;
}) {
  if (state.error === null) return <PageLoading />;
  return (
    <div>
      <PageHeader title={title} subtitle={subtitle} />
      <LoadError state={state} />
    </div>
  );
}
