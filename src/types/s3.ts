import type { z } from "zod";
import type { storageSettingsSchema } from "@/schemas/settings";

export type S3Runtime = S3Location & {
  accessKeyId: string;
  secretAccessKey: string;
};

export type SignInput = {
  method: string;
  url: URL;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  headers?: Record<string, string>;
  bodySha256?: string;
  now?: Date;
};

export type S3Location = {
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  addressing: S3AddressingStyle;
  publicBaseUrl: string;
};

export type S3Settings = z.infer<typeof storageSettingsSchema>;

export type S3AddressingSetting = "auto" | "path" | "virtual-hosted" | "domain";

export type S3AddressingStyle = Exclude<S3AddressingSetting, "auto">;

export type S3PresetId =
  | "aws"
  | "r2"
  | "minio"
  | "rustfs"
  | "hetzner"
  | "b2"
  | "wasabi"
  | "spaces"
  | "scaleway"
  | "ionos"
  | "custom";

export type S3Preset = {
  id: S3PresetId;
  endpoint: string;
  region: string;
  addressing: S3AddressingSetting;
  docs: string;
};

export type S3ProbeStep = "put" | "get" | "delete";

export type S3ProbeCode =
  | "KEYS_MISSING"
  | "BUCKET_MISSING"
  | "UNREACHABLE"
  | "AUTH"
  | "SIGNATURE"
  | "DENIED"
  | "NO_BUCKET"
  | "REGION"
  | "MISMATCH"
  | "FAILED";

export type S3ProbeResult =
  | { ok: true; latencyMs: number; key: string }
  | { ok: false; code: S3ProbeCode; step: S3ProbeStep | null; status: number | null };
