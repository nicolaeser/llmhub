import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import { s3FromParts, s3KeysPresent } from "@/lib/s3/config";
import { probeStorage } from "@/lib/s3/probe";
import { getEnterprise, normalizeS3, patchEnterprise } from "@/lib/settings/enterprise";
import { storageSettingsSchema } from "@/schemas/settings";
import type { Permission } from "@/types/auth";
import type { S3ProbeResult, S3Settings } from "@/types/s3";
import type { StorageSettingsView } from "@/types/settings";

function view(settings: S3Settings, permissions: readonly Permission[]): StorageSettingsView {
  const keys = s3KeysPresent();
  return {
    settings,
    keys,
    active: Boolean(settings.bucket) && keys.accessKeyId && keys.secretAccessKey,
    canManage: hasPerm(permissions, PERMISSIONS.SETTINGS_MANAGE),
  };
}

function parseStorage(raw: unknown): S3Settings {
  const parsed = storageSettingsSchema.safeParse(raw);
  if (!parsed.success) {
    const badUrl = parsed.error.issues.some((issue) => ["endpoint", "public_base_url"].includes(String(issue.path[0])));
    throw new Error(badUrl ? "INVALID_URL" : "VALIDATION");
  }
  return parsed.data;
}

export async function loadStorageSettings() {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_READ);
  return view(normalizeS3((await getEnterprise()).s3), session.permissions);
}

export async function saveStorageSettings(raw: unknown) {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const s3 = parseStorage(raw);
  const enterprise = await patchEnterprise({ s3 });
  await writeAudit({
    actor: session.user.id,
    action: "settings.storage",
    objectType: "enterprise",
    objectId: "enterprise",
    after: s3,
  });
  return view(normalizeS3(enterprise.s3), session.permissions);
}

export async function testStorageSettings(raw: unknown): Promise<S3ProbeResult> {
  const session = await requirePlatformPermission(PERMISSIONS.SETTINGS_MANAGE);
  const s3 = parseStorage(raw);
  const keys = s3KeysPresent();
  if (!keys.accessKeyId || !keys.secretAccessKey) return { ok: false, code: "KEYS_MISSING", step: null, status: null };
  const runtime = s3FromParts(s3, { S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY });
  if (!runtime) return { ok: false, code: "BUCKET_MISSING", step: null, status: null };
  const result = await probeStorage(runtime);
  await writeAudit({
    actor: session.user.id,
    action: "settings.storage_test",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { endpoint: runtime.endpoint, bucket: runtime.bucket, ok: result.ok, ...(result.ok ? {} : { code: result.code }) },
  });
  return result;
}
