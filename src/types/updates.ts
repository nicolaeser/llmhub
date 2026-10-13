export type ReleaseChannel = "stable" | "dev";

export type PublishedRelease = {
  tag: string;
  url: string;
  publishedAt: string;
  draft: boolean;
};

export type UpdateStatus = {
  current: string;
  latest: string | null;
  url: string | null;
  available: boolean;
};

export type BuildInfo = {
  version: string;
  startedAt: string;
};

export type ServerHealth = "connecting" | "ok" | "down";
