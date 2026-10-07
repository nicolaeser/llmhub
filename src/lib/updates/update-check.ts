import "server-only";
import { asRecord, asString } from "@/lib/gateway/core";
import { env } from "@/lib/env";
import { logger } from "@/lib/logging/logger";
import { noUpdate, releaseChannel, updateStatus } from "@/lib/updates/release-status";
import type { PublishedRelease, UpdateStatus } from "@/types/updates";

export const RELEASES_URL = "https://api.github.com/repos/nicolaeser/llmhub/releases?per_page=30";

const CHECK_TTL_MS = 6 * 3_600_000;
const FAILURE_TTL_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 10_000;

type CachedReleases = { releases: PublishedRelease[]; until: number };

const cacheHolder = globalThis as typeof globalThis & { __llmhubReleaseCache?: CachedReleases };

export function currentBuild(): string {
  return env.BUILD_ID ?? "development";
}

function releasesOf(json: unknown): PublishedRelease[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((item) => {
    const rec = asRecord(item);
    const tag = asString(rec?.tag_name);
    const url = asString(rec?.html_url);
    const publishedAt = asString(rec?.published_at) || asString(rec?.created_at);
    if (!rec || !tag || !url.startsWith("https://github.com/") || Number.isNaN(Date.parse(publishedAt))) return [];
    return [{ tag, url, publishedAt, draft: rec.draft === true }];
  });
}

async function fetchReleases(): Promise<PublishedRelease[]> {
  const res = await fetch(RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "llmhub-update-check",
    },
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`github releases answered ${res.status}`);
  return releasesOf(await res.json());
}

async function cachedReleases(): Promise<PublishedRelease[]> {
  const cached = cacheHolder.__llmhubReleaseCache;
  if (cached && cached.until > Date.now()) return cached.releases;
  try {
    const releases = await fetchReleases();
    cacheHolder.__llmhubReleaseCache = { releases, until: Date.now() + CHECK_TTL_MS };
    return releases;
  } catch (err) {
    logger.warn("update_check.failed", { err: err instanceof Error ? err.message : String(err) });
    const releases = cached?.releases ?? [];
    cacheHolder.__llmhubReleaseCache = { releases, until: Date.now() + FAILURE_TTL_MS };
    return releases;
  }
}

export async function checkForUpdate(enabled: boolean): Promise<UpdateStatus> {
  const current = currentBuild();
  if (!enabled || !releaseChannel(current)) return noUpdate(current);
  return updateStatus(current, await cachedReleases());
}
