import { z } from "zod";

export const UPDATER_STATES = [
  "idle",
  "checking",
  "pulling",
  "recreating",
  "verifying",
  "rolling_back",
  "failed",
] as const;

export const UPDATER_ACTIONS = ["check", "update"] as const;

export const UPDATER_ISSUES = [
  "docker_unavailable",
  "no_project",
  "no_targets",
  "mixed_images",
  "unsupported_image",
  "registry_unreachable",
] as const;

export const UPDATER_OUTCOMES = ["up_to_date", "available", "updated", "rolled_back", "failed", "pinned"] as const;

export const UPDATER_BODY_LIMIT = 16_384;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/).nullable();

const timestamp = z.iso.datetime({ offset: true });

export const updaterCommandId = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

const imageText = z.string().trim().max(300).regex(/^[\w.:/@-]+$/);

const byteCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const diskSpace = z.object({ freeBytes: byteCount, totalBytes: byteCount });

export const updaterHistoryEntrySchema = z.object({
  id: updaterCommandId,
  startedAt: timestamp,
  finishedAt: timestamp,
  outcome: z.enum(UPDATER_OUTCOMES),
  detail: z.string().max(300).nullable(),
  services: z.array(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/)).max(8),
  phases: z.object({ checking: byteCount, pulling: byteCount, recreating: byteCount, verifying: byteCount, rolling_back: byteCount }),
});

export const updaterReportSchema = z.object({
  version: z.string().trim().min(1).max(80),
  state: z.enum(UPDATER_STATES),
  issue: z.enum(UPDATER_ISSUES).nullable(),
  image: imageText.nullable(),
  tag: z.string().trim().max(128).regex(/^[\w.-]+$/).nullable(),
  pinned: z.boolean(),
  targets: z.number().int().min(0).max(100),
  currentDigest: digest,
  latestDigest: digest,
  available: z.boolean(),
  checkedAt: timestamp.nullable(),
  failedDigest: digest,
  lastResult: z
    .object({
      action: z.enum(UPDATER_ACTIONS),
      outcome: z.enum(UPDATER_OUTCOMES),
      at: timestamp,
      detail: z.string().max(500).nullable(),
      commandId: updaterCommandId.nullable(),
    })
    .nullable(),
  ackCommandId: updaterCommandId.nullable(),
  history: z.array(updaterHistoryEntrySchema).max(5).optional(),
  disk: diskSpace.nullable().optional(),
  progress: z.object({
    download: z.object({ downloadedBytes: byteCount, totalBytes: byteCount.nullable(), layersCompleted: byteCount, layersTotal: byteCount }).optional(),
    startup: z.enum(["migrating", "migration_failed", "starting", "manual_recovery"]).optional(),
    startedAt: timestamp,
    phaseStartedAt: timestamp,
    service: z.string().trim().min(1).max(300).nullable(),
    completed: z.number().int().min(0).max(100),
    total: z.number().int().min(0).max(100),
  }).refine((value) => value.completed <= value.total).nullable().optional(),
});

export const updaterCommandSchema = z.object({
  id: updaterCommandId,
  action: z.enum(UPDATER_ACTIONS),
  requestedAt: timestamp,
  requestedBy: z.string().max(64),
});

export const updaterActionSchema = z.enum(UPDATER_ACTIONS);

export const storedUpdaterStatusSchema = updaterReportSchema.extend({ seenAt: timestamp });
