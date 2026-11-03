import type { z } from "zod";
import type { updaterCommandSchema, updaterReportSchema } from "@/schemas/updater";

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

export type ServerHealth = "connecting" | "live" | "reconnecting" | "updating" | "restarting" | "down";

export type UpdaterState = z.infer<typeof updaterReportSchema>["state"];

export type UpdaterAction = UpdaterCommand["action"];

export type UpdaterReport = z.infer<typeof updaterReportSchema>;

export type UpdaterCommand = z.infer<typeof updaterCommandSchema>;

export type UpdaterDesired = {
  auto: boolean;
  command: { id: string; action: UpdaterAction } | null;
};

export type StoredUpdaterStatus = UpdaterReport & { seenAt: string };

export type UpdaterView = {
  connected: boolean;
  seenAt: string | null;
  version: string;
  state: UpdaterState;
  issue: UpdaterReport["issue"];
  image: string | null;
  tag: string | null;
  pinned: boolean;
  targets: number;
  currentDigest: string | null;
  latestDigest: string | null;
  available: boolean;
  checkedAt: string | null;
  lastResult: UpdaterReport["lastResult"];
  auto: boolean;
  pending: UpdaterAction | null;
};

export type UpdaterSnapshot = {
  build: BuildInfo;
  updater: UpdaterView | null;
  updating: boolean;
};

export type LiveStatus = {
  build: BuildInfo;
  updater: UpdaterView | null;
  updating: boolean;
  canRead: boolean;
  canManage: boolean;
};

export type LiveLink = "connecting" | "open" | "lost";
