import "server-only";

import prisma from "@/lib/db/prisma";
import { archivedBefore, retentionHolds } from "@/lib/compliance-archive/plan";
import type { ArchiveDataset, RetentionHolds } from "@/types/archive";
import type { Enterprise } from "@/types/settings";

export async function archivedBeforeOf(dataset: ArchiveDataset): Promise<Date> {
  const [firstOpen, lastDone] = await Promise.all([
    prisma.complianceArchiveRun.findFirst({
      where: { dataset, status: { in: ["pending", "running", "failed"] } },
      orderBy: { day: "asc" },
      select: { dataset: true, day: true, status: true },
    }),
    prisma.complianceArchiveRun.findFirst({
      where: { dataset, status: { in: ["done", "expired"] } },
      orderBy: { day: "desc" },
      select: { dataset: true, day: true, status: true },
    }),
  ]);
  return archivedBefore([firstOpen, lastDone].filter((run) => run !== null));
}

export async function archiveRetentionHolds(enterprise: Enterprise): Promise<RetentionHolds> {
  const settings = enterprise.compliance_archive;
  if (!settings?.enabled || !settings.datasets.length) return {};
  const byDataset: Partial<Record<ArchiveDataset, Date>> = {};
  for (const dataset of settings.datasets) byDataset[dataset] = await archivedBeforeOf(dataset);
  return retentionHolds(settings, byDataset);
}
