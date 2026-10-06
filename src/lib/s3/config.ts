import "server-only";

import { env } from "@/lib/env";
import { getEnterprise } from "@/lib/gateway/settings";
import {
  defaultAwsEndpoint,
  originOf,
  resolveAddressing,
  trimSlashes
} from "@/lib/s3/url";
import type { S3Settings } from "@/types/gateway";
import type { S3Runtime } from "@/types/s3";

export function s3FromParts(
  settings: S3Settings | undefined,
  source: { S3_ACCESS_KEY_ID?: string; S3_SECRET_ACCESS_KEY?: string },
): S3Runtime | null {
  const bucket = (settings?.bucket || "").trim();
  const accessKeyId = (source.S3_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (source.S3_SECRET_ACCESS_KEY || "").trim();
  const enabled = settings?.enabled !== false;
  if (!enabled || !bucket || !accessKeyId || !secretAccessKey) return null;

  const region = (settings?.region || "us-east-1").trim();
  const endpoint = originOf(settings?.endpoint || "", defaultAwsEndpoint(region));
  const domainBucket = Boolean(settings?.domain_bucket);
  const addressing = resolveAddressing({
    addressing: settings?.addressing || "auto",
    forcePathStyle: false,
    domainBucket,
    bucket,
    endpoint,
  });
  return {
    bucket,
    region,
    endpoint,
    prefix: trimSlashes(settings?.prefix || ""),
    addressing,
    domainBucket,
    publicBaseUrl: (settings?.public_base_url || "").trim(),
    accessKeyId,
    secretAccessKey,
    sessionToken: "",
  };
}

export async function resolveS3Config(): Promise<S3Runtime | null> {
  const enterprise = await getEnterprise().catch(() => null);
  return s3FromParts(enterprise?.s3, {
    S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY,
  });
}

export function objectStorageKey(kind: string, id: string, filename = ""): string {
  const safeKind = kind.replace(/[^a-zA-Z0-9._/-]+/g, "-") || "object";
  const safeName = filename.replace(/^\/+/, "").replaceAll("..", "");
  return [safeKind, id, safeName].filter(Boolean).join("/");
}
