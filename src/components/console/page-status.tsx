"use client";

import type { ReactNode } from "react";
import { Alert, Button, Spinner } from "@heroui/react";
import { RotateCcw, type LucideIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import type { LoadStatus } from "@/types/actions";
import PageHeader from "./page-header";
import {
  ChartsSkeleton,
  DetailsSkeleton,
  FiltersSkeleton,
  HeaderSkeleton,
  LayoutSkeleton,
  ListSkeleton,
  StatsSkeleton,
  TableSkeleton,
  TabsSkeleton,
  type LoadingLayout,
  type StatCount,
} from "./skeletons";

export type LoadingShape = {
  layout?: LoadingLayout;
  stats?: StatCount;
  tabs?: boolean;
  filters?: number;
};

type SectionShape = "list" | "details" | "table" | "charts";

type HeaderProps = {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
};

export function PageLoading({
  title,
  subtitle,
  icon,
  header = false,
  layout = "table",
  stats = 0,
  tabs = false,
  filters = 0,
}: HeaderProps & LoadingShape & { header?: boolean }) {
  const t = useTranslations("Common");
  return (
    <div>
      {title ? (
        <PageHeader icon={icon} title={title} subtitle={subtitle} subtitlePending={!subtitle} />
      ) : header ? (
        <HeaderSkeleton />
      ) : null}
      <output aria-live="polite" className="sr-only">
        {t("loading")}
      </output>
      <div aria-busy="true" className="space-y-5">
        {filters ? <FiltersSkeleton fields={filters} /> : null}
        {tabs ? <TabsSkeleton /> : null}
        {stats ? <StatsSkeleton count={stats} /> : null}
        <LayoutSkeleton layout={layout} />
      </div>
    </div>
  );
}

function SectionSkeleton({ shape, rows }: { shape: SectionShape; rows: number }) {
  if (shape === "details") return <DetailsSkeleton />;
  if (shape === "table") return <TableSkeleton rows={rows} />;
  if (shape === "charts") return <ChartsSkeleton />;
  return <ListSkeleton rows={rows} />;
}

export function SectionLoading({ shape = "list", rows = 3 }: { shape?: SectionShape; rows?: number }) {
  const t = useTranslations("Common");
  return (
    <div>
      <output aria-live="polite" className="sr-only">
        {t("loading")}
      </output>
      <div aria-busy="true">
        <SectionSkeleton shape={shape} rows={rows} />
      </div>
    </div>
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
  icon,
  state,
  ...shape
}: HeaderProps & LoadingShape & { state: LoadStatus }) {
  if (state.error === null) return <PageLoading title={title} subtitle={subtitle} icon={icon} {...shape} />;
  if (!title) return <LoadError state={state} />;
  return (
    <div>
      <PageHeader icon={icon} title={title} subtitle={subtitle} />
      <LoadError state={state} />
    </div>
  );
}
