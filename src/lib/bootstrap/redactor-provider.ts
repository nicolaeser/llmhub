import "server-only";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";

export const REDACTOR_PROVIDER_ID = "llmhub-redactor";
export const REDACTOR_ALIAS = "pii-tracer";
export const REDACTOR_DEPLOYMENT_ID = "llmhub-redactor-pii-tracer";

const REDACTOR_KIND = "openai_compat";
const REDACTOR_NAME = "PII redactor (LLMHUB_REDACTOR_URL)";
const REDACTOR_DISPLAY_NAME = "PII-Tracer";

export async function syncRedactorProvider(url: string | undefined): Promise<void> {
  if (!url) {
    await prisma.providerConnection.updateMany({
      where: { id: REDACTOR_PROVIDER_ID, enabled: true },
      data: { enabled: false },
    });
    return;
  }
  const route = { kind: REDACTOR_KIND, baseUrl: "", model: REDACTOR_ALIAS, providerId: REDACTOR_PROVIDER_ID };
  await prisma.providerConnection.upsert({
    where: { id: REDACTOR_PROVIDER_ID },
    update: { kind: REDACTOR_KIND, baseUrl: url, internal: true, enabled: true },
    create: { id: REDACTOR_PROVIDER_ID, name: REDACTOR_NAME, kind: REDACTOR_KIND, baseUrl: url, internal: true },
  });
  await prisma.modelGroup.upsert({
    where: { alias: REDACTOR_ALIAS },
    update: {},
    create: { alias: REDACTOR_ALIAS, displayName: REDACTOR_DISPLAY_NAME },
  });
  await prisma.deployment.upsert({
    where: { id: REDACTOR_DEPLOYMENT_ID },
    update: { groupAlias: REDACTOR_ALIAS, ...route },
    create: { id: REDACTOR_DEPLOYMENT_ID, groupAlias: REDACTOR_ALIAS, ...route },
  });
}

export async function ensureRedactorProvider(): Promise<void> {
  try {
    await syncRedactorProvider(env.LLMHUB_REDACTOR_URL);
  } catch (err) {
    logger.warn("redactor.provider_sync_failed", errorFields(err));
  }
}
