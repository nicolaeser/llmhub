"use client";

import Image from "next/image";
import { useTranslations } from "next-intl";
import { Button, Card, toast } from "@heroui/react";
import { Copy, ExternalLink } from "lucide-react";
import type { TotpEnrollment } from "@/types/security";

export function TotpEnrollmentPanel({ enrollment }: { enrollment: TotpEnrollment }) {
  const t = useTranslations("Security");
  const grouped = enrollment.secret.match(/.{1,4}/g)?.join(" ") ?? "";
  return (
    <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start">
      <Image
        src={enrollment.qrDataUrl}
        alt={t("qrAlt")}
        width={240}
        height={240}
        unoptimized
        className="size-48 shrink-0 self-center rounded-xl border border-border bg-white sm:size-52 sm:self-start"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <ol className="flex list-decimal flex-col gap-2 ps-5 text-sm text-muted">
          <li>{t("enrollStepApp")}</li>
          <li>{t("enrollStepScan")}</li>
          <li>{t("enrollStepConfirm")}</li>
        </ol>
        <a
          href={enrollment.uri}
          className="inline-flex w-fit items-center gap-1.5 text-sm font-medium text-accent underline-offset-4 hover:underline sm:hidden"
        >
          <ExternalLink size={14} aria-hidden />
          {t("openInApp")}
        </a>
        <div className="min-w-0">
          <p className="text-xs text-muted">{t("manualKey")}</p>
          <div className="mt-1 flex min-w-0 items-start gap-2">
            <Card variant="secondary" className="min-w-0 flex-1 px-3 py-2">
              <code className="font-mono text-sm break-all">{grouped}</code>
            </Card>
            <Button
              isIconOnly
              size="sm"
              variant="secondary"
              aria-label={t("copyKey")}
              onPress={async () => {
                try {
                  await navigator.clipboard.writeText(enrollment.secret);
                  toast(t("copied"), { variant: "success" });
                } catch {
                  toast.danger(t("copyFailed"));
                }
              }}
            >
              <Copy size={14} aria-hidden />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
