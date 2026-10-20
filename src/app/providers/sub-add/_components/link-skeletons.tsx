"use client";

import { Card, Separator, Skeleton } from "@heroui/react";
import { useTranslations } from "next-intl";

function LoadingIntro({ title, lines }: { title: string; lines: string[] }) {
  const t = useTranslations("Common");
  return (
    <div className="space-y-2">
      <h1 className="text-3xl font-semibold tracking-tight break-words sm:text-4xl">{title}</h1>
      {lines.map((width, line) => (
        <Skeleton key={line} className={`my-1 h-3 rounded-lg ${width}`} />
      ))}
      <output aria-live="polite" className="sr-only">
        {t("loading")}
      </output>
    </div>
  );
}

export function OfferSkeleton() {
  const t = useTranslations("SubAdd");
  return (
    <div className="space-y-6">
      <LoadingIntro title={t("title")} lines={["w-4/5", "w-1/2", "w-2/5"]} />
      <div aria-busy="true" className="space-y-6">
        <Skeleton className="h-44 w-full rounded-2xl" />
        <Card className="gap-5">
          <Card.Header className="space-y-2">
            <Skeleton className="h-4 w-40 rounded-lg" />
            <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
          </Card.Header>
          <Card.Content className="gap-5">
            <div className="grid gap-2 sm:grid-cols-2">
              {[0, 1].map((kind) => (
                <Card key={kind} variant="secondary" className="flex-row items-start gap-3">
                  <Skeleton className="size-9 shrink-0 rounded-lg" />
                  <div className="w-full min-w-0 space-y-2">
                    <Skeleton className="h-3.5 w-24 rounded-lg" />
                    <Skeleton className="h-3 w-32 max-w-full rounded-lg" />
                  </div>
                </Card>
              ))}
            </div>
            <Skeleton className="h-11 w-full rounded-3xl" />
          </Card.Content>
        </Card>
      </div>
    </div>
  );
}

export function ContributionsSkeleton() {
  const t = useTranslations("SubAdd.manage");
  return (
    <div className="space-y-6">
      <LoadingIntro title={t("title")} lines={["w-3/4"]} />
      <div aria-busy="true" className="space-y-6">
        <Card className="gap-4">
          <Card.Header className="space-y-2">
            <Skeleton className="h-4 w-36 rounded-lg" />
            <Skeleton className="h-3 w-64 max-w-full rounded-lg" />
          </Card.Header>
          <Card.Content>
            {[0, 1].map((row) => (
              <div key={row}>
                {row ? <Separator /> : null}
                <div className="flex flex-wrap items-center gap-3 py-3">
                  <Skeleton className="size-9 shrink-0 rounded-lg" />
                  <div className="min-w-0 flex-1 basis-48 space-y-2">
                    <Skeleton className="h-3.5 w-24 rounded-lg" />
                    <Skeleton className="h-3 w-40 max-w-full rounded-lg" />
                    <Skeleton className="h-2.5 w-28 rounded-lg" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-6 w-16 rounded-2xl" />
                    <Skeleton className="h-8 w-24 rounded-3xl" />
                  </div>
                </div>
              </div>
            ))}
          </Card.Content>
        </Card>
        <Skeleton className="h-3 w-3/5 rounded-lg" />
      </div>
    </div>
  );
}
