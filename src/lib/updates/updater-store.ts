import "server-only";
import prisma from "@/lib/db/prisma";
import { asRecord } from "@/lib/gateway/core";
import { parseJsonOrNull } from "@/lib/utils/json";
import { buildInfo } from "@/lib/updates/build";
import { isRestarting, updaterView } from "@/lib/updates/updater-view";
import { storedUpdaterStatusSchema, updaterCommandSchema } from "@/schemas/updater";
import type { StoredUpdaterStatus, UpdaterCommand, UpdaterSnapshot } from "@/types/updates";

export const UPDATER_STATUS_SETTING = "updater_status";
export const UPDATER_COMMAND_SETTING = "updater_command";
const ENTERPRISE_SETTING = "enterprise";

export type UpdaterRows = {
  status: StoredUpdaterStatus | null;
  command: UpdaterCommand | null;
  commandRaw: string | null;
  auto: boolean;
};

export async function readUpdaterRows(): Promise<UpdaterRows> {
  const rows = await prisma.setting.findMany({
    where: { key: { in: [UPDATER_STATUS_SETTING, UPDATER_COMMAND_SETTING, ENTERPRISE_SETTING] } },
    select: { key: true, value: true },
  });
  const raw = new Map(rows.map((row) => [row.key, row.value]));
  const status = storedUpdaterStatusSchema.safeParse(parseJsonOrNull(raw.get(UPDATER_STATUS_SETTING) ?? ""));
  const command = updaterCommandSchema.safeParse(parseJsonOrNull(raw.get(UPDATER_COMMAND_SETTING) ?? ""));
  const enterprise = asRecord(parseJsonOrNull(raw.get(ENTERPRISE_SETTING) ?? ""));
  return {
    status: status.success ? status.data : null,
    command: command.success ? command.data : null,
    commandRaw: raw.get(UPDATER_COMMAND_SETTING) ?? null,
    auto: enterprise?.auto_update === true,
  };
}

function snapshotOf(rows: UpdaterRows, now: number): UpdaterSnapshot {
  return {
    build: buildInfo(),
    updater: updaterView(rows.status, rows.command, rows.auto, now),
    updating: isRestarting(rows.status, now),
  };
}

export async function updaterSnapshot(now = Date.now()): Promise<UpdaterSnapshot> {
  return snapshotOf(await readUpdaterRows(), now);
}

export async function replacedByUpdater(now = Date.now()): Promise<boolean> {
  return isRestarting((await readUpdaterRows()).status, now);
}

export async function writeSetting(key: string, value: unknown): Promise<string> {
  const serialized = JSON.stringify(value);
  await prisma.setting.upsert({
    where: { key },
    update: { value: serialized },
    create: { key, value: serialized },
  });
  return serialized;
}

export async function clearCommand(raw: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key: UPDATER_COMMAND_SETTING, value: raw } });
}
