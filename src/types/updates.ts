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
