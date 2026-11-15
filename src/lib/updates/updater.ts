import "server-only";
import { randomUUID } from "node:crypto";
import { requirePermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { patchEnterprise } from "@/lib/settings/enterprise";
import { publishLive } from "@/lib/updates/live";
import {
  claimCommand,
  clearCommand,
  readUpdaterRows,
  UPDATER_STATUS_SETTING,
  writeSetting,
} from "@/lib/updates/updater-store";
import { commandActive, desiredState, recoveryRequired, updaterConnected, updaterView } from "@/lib/updates/updater-view";
import { updaterActionSchema } from "@/schemas/updater";
import type { UpdaterCommand, UpdaterDesired, UpdaterReport, UpdaterView } from "@/types/updates";

export async function receiveUpdaterReport(report: UpdaterReport, now = Date.now()): Promise<UpdaterDesired> {
  const rows = await readUpdaterRows();
  await writeSetting(UPDATER_STATUS_SETTING, { ...report, history: report.history ?? rows.status?.history ?? [], seenAt: new Date(now).toISOString() });
  const command = rows.command;
  if (rows.commandRaw && (command?.id === report.ackCommandId || !commandActive(command, now))) {
    await clearCommand(rows.commandRaw);
  }
  publishLive();
  const current = await readUpdaterRows();
  return desiredState(current.auto, current.command, now);
}

export async function setAutoUpdate(enabled: unknown): Promise<UpdaterView | null> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  if (typeof enabled !== "boolean") throw new Error("VALIDATION");
  await patchEnterprise({ auto_update: enabled });
  await writeAudit({
    actor: session.user.id,
    action: "settings.auto_update",
    objectType: "enterprise",
    objectId: "enterprise",
    after: { auto_update: enabled },
  });
  publishLive();
  const rows = await readUpdaterRows();
  return updaterView(rows.status, rows.command, enabled, Date.now());
}

export async function requestUpdaterCommand(raw: unknown): Promise<UpdaterView | null> {
  const session = await requirePermission(PERMISSIONS.SETTINGS_MANAGE);
  const parsed = updaterActionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const rows = await readUpdaterRows();
    const now = Date.now();
    if (!rows.status || !updaterConnected(rows.status, now)) throw new Error("UPDATER_OFFLINE");
    if (recoveryRequired(rows.status)) throw new Error("UPDATER_RECOVERY_REQUIRED");
    if (parsed.data === "update" && rows.status.pinned) throw new Error("UPDATER_PINNED");
    if (commandActive(rows.command, now)) return updaterView(rows.status, rows.command, rows.auto, now);
    const command: UpdaterCommand = {
      id: randomUUID(),
      action: parsed.data,
      requestedAt: new Date(now).toISOString(),
      requestedBy: session.user.id,
    };
    if (!await claimCommand(rows.commandRaw, command)) continue;
    await writeAudit({
      actor: session.user.id,
      action: "updater.command",
      objectType: "updater",
      objectId: command.id,
      after: { action: command.action },
    });
    publishLive();
    const current = await readUpdaterRows();
    return updaterView(current.status, current.command, current.auto, Date.now());
  }
  throw new Error("REQUEST_FAILED");
}
