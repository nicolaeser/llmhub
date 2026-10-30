"use client";

import { ChevronLeft } from "lucide-react";
import { useTranslations } from "next-intl";
import { PageLoading } from "@/components/console/page-status";
import { Link } from "@/i18n/routing";

export default function KeyDetailSkeleton() {
  const t = useTranslations("Keys.detail");
  return (
    <div>
      <Link
        href="/keys"
        className="-ml-1 mb-3 inline-flex w-fit items-center gap-1 rounded-lg px-1 text-sm text-muted hover:text-foreground motion-safe:transition-colors"
      >
        <ChevronLeft size={14} aria-hidden className="shrink-0" />
        <span className="break-words">{t("back")}</span>
      </Link>
      <PageLoading header tabs stats={4} layout="columns" />
    </div>
  );
}
