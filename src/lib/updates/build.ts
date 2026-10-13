import "server-only";
import { env } from "@/lib/env";
import { DEVELOPMENT_BUILD } from "@/lib/updates/build-change";
import type { BuildInfo } from "@/types/updates";

const STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

export function currentBuild(): string {
  return env.BUILD_ID ?? DEVELOPMENT_BUILD;
}

export function buildInfo(): BuildInfo {
  return { version: currentBuild(), startedAt: STARTED_AT };
}
