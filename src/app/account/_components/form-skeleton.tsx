"use client";

import { Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";

export default function FormSkeleton({ fields }: { fields: number }) {
  const t = useTranslations("Common");
  return (
    <div className="space-y-5">
      <output aria-live="polite" className="sr-only">
        {t("loading")}
      </output>
      <div aria-busy="true" className="space-y-5">
        {Array.from({ length: fields }, (_, field) => (
          <div key={field} className="space-y-2">
            <Skeleton className="h-3.5 w-24 rounded-lg" />
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ))}
        <Skeleton className="h-11 w-full rounded-3xl" />
      </div>
    </div>
  );
}
