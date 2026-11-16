"use client";

import type { ReactNode } from "react";
import { Alert, buttonVariants, Label, Meter, Separator } from "@heroui/react";
import { ArrowRight, PackageOpen } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import IconTile from "@/components/console/icon-tile";
import { Link } from "@/i18n/routing";
import { diskLow, shortDigest, UPDATER_MIN_FREE_DISK_BYTES } from "@/lib/updates/updater-view";
import { formatBytes } from "@/lib/utils/bytes";
import type { UpdaterView } from "@/types/updates";
import { AutoUpdateSwitch, UpdaterButtons } from "./updater-controls";
import UpdaterActivity from "./updater-activity";

export const UPDATES_HREF = "/settings?tab=updates";

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 text-sm">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-foreground">{children}</span>
    </li>
  );
}

export function UpdaterFacts({ updater }: { updater: UpdaterView }) {
  const t = useTranslations("Common.updater");
  const format = useFormatter();
  const unknown = t("unknown");
  const disk = updater.disk;
  const low = diskLow(updater);
  const newer = updater.latestDigest && updater.latestDigest !== updater.currentDigest;

  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border">
        <Fact label={t("image")}>
          <code className="font-mono text-xs break-all">{updater.image ? `${updater.image}:${updater.tag ?? ""}` : unknown}</code>
        </Fact>
        <Fact label={t("running")}>
          <code className="font-mono text-xs">{shortDigest(updater.currentDigest) || unknown}</code>
        </Fact>
        {newer ? (
          <Fact label={t("latest")}>
            <code className="font-mono text-xs">{shortDigest(updater.latestDigest)}</code>
          </Fact>
        ) : null}
      </ul>
      {disk && disk.totalBytes > 0 ? (
        <Meter
          size="sm"
          value={disk.totalBytes - disk.freeBytes}
          maxValue={disk.totalBytes}
          color={low ? "warning" : "accent"}
        >
          <Label>{t("diskLabel")}</Label>
          <Meter.Output>
            {t("disk", { free: formatBytes(format, disk.freeBytes), total: formatBytes(format, disk.totalBytes) })}
          </Meter.Output>
          <Meter.Track>
            <Meter.Fill />
          </Meter.Track>
        </Meter>
      ) : null}
      {disk && low ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {t("diskLow", {
                free: formatBytes(format, disk.freeBytes),
                required: formatBytes(format, UPDATER_MIN_FREE_DISK_BYTES),
              })}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {updater.pinned ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{t("pinned", { tag: updater.tag ?? "" })}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
    </div>
  );
}

export function UpdaterMissing({ withCommand }: { withCommand: boolean }) {
  const t = useTranslations("Common.updater");
  return (
    <div className="flex items-start gap-3">
      <IconTile icon={PackageOpen} tone="neutral" size="lg" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-semibold text-foreground">{t("missingTitle")}</p>
        <p className="text-sm text-muted">{t("missing")}</p>
        {withCommand ? <code className="block font-mono text-xs break-all text-foreground">{t("command")}</code> : null}
      </div>
    </div>
  );
}

export default function UpdaterPanel({
  updater,
  canManage,
  onView,
  onOpenDetails,
}: {
  updater: UpdaterView | null;
  canManage: boolean;
  onView: (view: UpdaterView | null) => void;
  onOpenDetails?: () => void;
}) {
  const t = useTranslations("Common.updater");
  const details = onOpenDetails ? (
    <Link href={UPDATES_HREF} onClick={onOpenDetails} className={buttonVariants({ size: "sm", variant: "secondary", fullWidth: true })}>
      {t("details")}
      <ArrowRight size={14} aria-hidden />
    </Link>
  ) : null;

  if (!updater) {
    return (
      <div className="space-y-4">
        <UpdaterMissing withCommand={false} />
        {details}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <UpdaterActivity updater={updater} />
      {canManage ? <UpdaterButtons updater={updater} onView={onView} size="sm" /> : null}
      {canManage ? (
        <>
          <Separator />
          <AutoUpdateSwitch updater={updater} onView={onView} />
        </>
      ) : null}
      {details}
    </div>
  );
}
