import { S3Error } from "@/lib/s3/client";
import { s3ProbeCode } from "@/lib/s3/probe";
import { ARCHIVE_ERROR_CODES } from "@/lib/compliance-archive/options";
import type { ArchiveErrorCode } from "@/types/archive";

const NETWORK_ERRORS = new Set(["AbortError", "TimeoutError"]);

function isArchiveCode(value: string): value is ArchiveErrorCode {
  return (ARCHIVE_ERROR_CODES as readonly string[]).includes(value);
}

export function archiveErrorCode(err: unknown, lockActive: boolean): ArchiveErrorCode {
  if (err instanceof S3Error) {
    if (lockActive && (err.code === "InvalidRequest" || err.code === "InvalidBucketState" || err.code === "ObjectLockConfigurationNotFoundError")) {
      return "LOCK_UNSUPPORTED";
    }
    const code = s3ProbeCode(err).code;
    return isArchiveCode(code) ? code : "FAILED";
  }
  if (err instanceof Error) {
    if (isArchiveCode(err.message)) return err.message;
    if (NETWORK_ERRORS.has(err.name) || (err instanceof TypeError && err.message === "fetch failed")) return "UNREACHABLE";
  }
  return "FAILED";
}
