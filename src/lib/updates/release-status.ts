import type { PublishedRelease, ReleaseChannel, UpdateStatus } from "@/types/updates";

const STABLE_TAG = /^v(\d{4}\.\d{2}\.\d{2})\.[0-9a-f]+$/;
const DEV_TAG = /^dev-(\d{4}\.\d{2}\.\d{2})\.[0-9a-f]+$/;

export function releaseChannel(tag: string): ReleaseChannel | null {
  if (STABLE_TAG.test(tag)) return "stable";
  if (DEV_TAG.test(tag)) return "dev";
  return null;
}

function releaseDate(tag: string): string {
  return STABLE_TAG.exec(tag)?.[1] ?? DEV_TAG.exec(tag)?.[1] ?? "";
}

export function noUpdate(current: string): UpdateStatus {
  return { current, latest: null, url: null, available: false };
}

export function updateStatus(current: string, releases: PublishedRelease[]): UpdateStatus {
  const channel = releaseChannel(current);
  if (!channel) return noUpdate(current);
  const pool = releases
    .filter((release) => !release.draft && releaseChannel(release.tag) === channel)
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const latest = pool[0];
  if (!latest) return noUpdate(current);
  const status = { current, latest: latest.tag, url: latest.url };
  if (latest.tag === current) return { ...status, available: false };
  const running = pool.find((release) => release.tag === current);
  const available = running
    ? Date.parse(latest.publishedAt) > Date.parse(running.publishedAt)
    : releaseDate(latest.tag) > releaseDate(current);
  return { ...status, available };
}
