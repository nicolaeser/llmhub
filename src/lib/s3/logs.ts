import "server-only";

import { resolveS3Config } from "@/lib/s3/config";
import { joinKey } from "@/lib/s3/url";
import { s3Put } from "@/lib/s3/client";

export async function archiveLogJson(kind: string, id: string, payload: unknown): Promise<void> {
  const runtime = await resolveS3Config();
  if (!runtime) return;
  const day = new Date().toISOString().slice(0, 10).split("-");
  await s3Put(
    runtime,
    joinKey("logs", kind, ...day, `${id}.json`),
    Buffer.from(`${JSON.stringify(payload)}\n`),
    "application/jsonl",
  );
}
