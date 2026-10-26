import "server-only";

import prisma from "@/lib/db/prisma";
import { asStringArray } from "@/lib/gateway/core";
import type { ProviderPresetUsage } from "@/types/providers";

export async function providerPresetUsage(): Promise<ProviderPresetUsage> {
  const presets = await prisma.modelTemplate.findMany({
    select: { name: true, providerIds: true },
    orderBy: { name: "asc" },
  });
  const usage: ProviderPresetUsage = {};
  for (const preset of presets) {
    for (const id of new Set(asStringArray(preset.providerIds))) {
      usage[id] = [...(usage[id] ?? []), preset.name];
    }
  }
  return usage;
}
