import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { claimCommand, clearCommand } from "@/lib/updates/updater-store";
import { receiveUpdaterReport, requestUpdaterCommand } from "@/lib/updates/updater";
import { isRestarting, updaterConnected, updaterView, UPDATER_COMMAND_TTL_MS } from "@/lib/updates/updater-view";
import type { AuthenticatedSession } from "@/types/auth";
import type { StoredUpdaterStatus, UpdaterCommand } from "@/types/updates";

function status(): StoredUpdaterStatus {
  return {
    version: "test", state: "idle", issue: null, image: null, tag: null,
    pinned: false, targets: 1, currentDigest: null, latestDigest: null,
    available: false, checkedAt: null, failedDigest: null, lastResult: null,
    ackCommandId: null, seenAt: new Date().toISOString(),
  };
}

function command(id = "command-first", requestedAt = new Date().toISOString()): UpdaterCommand {
  return { id, action: "check", requestedAt, requestedBy: "operator" };
}

function store(initial: Record<string, string> = {}, onWrite?: (rows: Map<string, string>) => void) {
  const rows = new Map(Object.entries(initial));
  recordedPrisma.reset({ setting: {
    findMany: () => [...rows].map(([key, value]) => ({ key, value })),
    upsert: ({ where, update }: { where: { key: string }; update: { value: string } }) => {
      rows.set(where.key, update.value);
      onWrite?.(rows);
      return { key: where.key, value: update.value };
    },
    createMany: ({ data }: { data: { key: string; value: string }[] }) => {
      if (rows.has(data[0].key)) return { count: 0 };
      rows.set(data[0].key, data[0].value);
      return { count: 1 };
    },
    updateMany: ({ where, data }: { where: { key: string; value: string }; data: { value: string } }) => {
      if (rows.get(where.key) !== where.value) return { count: 0 };
      rows.set(where.key, data.value);
      return { count: 1 };
    },
    deleteMany: ({ where }: { where: { key: string; value: string } }) => {
      if (rows.get(where.key) !== where.value) return { count: 0 };
      rows.delete(where.key);
      return { count: 1 };
    },
  } });
  return rows;
}

const manager: AuthenticatedSession = {
  error: false, sessionId: "bridge-session",
  user: { id: "operator", orgId: null } as AuthenticatedSession["user"],
  isOwner: false, role: null, permissions: ["settings:manage"], secondFactor: "TOTP",
  ipAddress: null, userAgent: null, workspaceOrgId: null,
};

test("concurrent requests retain one command and one audit instead of replacing each other", async () => {
  const rows = store({ updater_status: JSON.stringify(status()) });
  const views = await Promise.all(Array.from({ length: 8 }, () => runAsPrincipal(manager, () => requestUpdaterCommand("check"))));
  assert.ok(rows.has("updater_command"));
  assert.equal(recordedPrisma.called("gatewayAuditLog", "create").length, 1);
  assert.ok(views.every((view) => view?.pending === "check"));
  const saved = rows.get("updater_command");
  await runAsPrincipal(manager, () => requestUpdaterCommand("update"));
  assert.equal(rows.get("updater_command"), saved);
});

test("command replacement and acknowledgement cannot erase a concurrent winner", async () => {
  const old = JSON.stringify(command());
  const rows = store({ updater_command: old });
  const next = command("command-next");
  assert.equal(await claimCommand(old, next), true);
  assert.equal(await claimCommand(old, command("command-loser")), false);
  await clearCommand(old);
  assert.deepEqual(JSON.parse(rows.get("updater_command")!), next);
});

test("heartbeat returns a command and auto setting changed during status persistence", async () => {
  const next = command("command-latest");
  store({}, (rows) => {
    rows.set("updater_command", JSON.stringify(next));
    rows.set("enterprise", JSON.stringify({ auto_update: true }));
  });
  assert.deepEqual(await receiveUpdaterReport(status()), { auto: true, command: { id: next.id, action: next.action } });
});

test("acknowledging an old command returns its concurrently queued successor", async () => {
  const old = command();
  const next = command("command-successor");
  const rows = store({ updater_command: JSON.stringify(old) }, (rows) => rows.set("updater_command", JSON.stringify(next)));
  assert.deepEqual(await receiveUpdaterReport({ ...status(), ackCommandId: old.id }), {
    auto: false, command: { id: next.id, action: next.action },
  });
  assert.deepEqual(JSON.parse(rows.get("updater_command")!), next);
});

test("expired commands are cleared and cannot be returned to the agent", async () => {
  const now = Date.now();
  const rows = store({ updater_command: JSON.stringify(command("command-expired", new Date(now - UPDATER_COMMAND_TTL_MS).toISOString())) });
  assert.deepEqual(await receiveUpdaterReport(status(), now), { auto: false, command: null });
  assert.equal(rows.has("updater_command"), false);
});

test("unauthorized commands fail before any database access", async () => {
  store();
  await assert.rejects(runAsPrincipal({ ...manager, permissions: [] }, () => requestUpdaterCommand("update")), /FORBIDDEN/);
  assert.equal(recordedPrisma.calls.length, 0);
});

test("far-future heartbeats cannot keep the updater connected or restarting", () => {
  const now = Date.now();
  const future = { ...status(), state: "recreating" as const, seenAt: new Date(now + 60_000).toISOString() };
  assert.equal(updaterConnected(future, now), false);
  assert.equal(isRestarting(future, now), false);
  assert.equal(updaterView(status(), null, false, now)?.progress, null);
});

test("new requests replace expired commands but reject disconnected or pinned updaters", async () => {
  const expired = command("command-expired", new Date(Date.now() - UPDATER_COMMAND_TTL_MS).toISOString());
  const rows = store({ updater_status: JSON.stringify(status()), updater_command: JSON.stringify(expired) });
  await runAsPrincipal(manager, () => requestUpdaterCommand("update"));
  const saved = JSON.parse(rows.get("updater_command")!) as UpdaterCommand;
  assert.notEqual(saved.id, expired.id);
  assert.equal(saved.action, "update");
  store({ updater_status: JSON.stringify({ ...status(), pinned: true }) });
  await assert.rejects(runAsPrincipal(manager, () => requestUpdaterCommand("update")), /UPDATER_PINNED/);
  store({ updater_status: JSON.stringify({ ...status(), seenAt: new Date(0).toISOString() }) });
  await assert.rejects(runAsPrincipal(manager, () => requestUpdaterCommand("check")), /UPDATER_OFFLINE/);
});

test("progress survives the stored report and console view round trip", async () => {
  const progress = {
    startedAt: new Date().toISOString(), phaseStartedAt: new Date().toISOString(),
    service: "app", completed: 1, total: 3,
  };
  const rows = store();
  await receiveUpdaterReport({ ...status(), progress });
  const saved = JSON.parse(rows.get("updater_status")!) as StoredUpdaterStatus;
  assert.deepEqual(updaterView(saved, null, false, Date.now())?.progress, progress);
});

test("manual migration recovery refuses new commands without queueing them", async () => {
  const rows = store({ updater_status: JSON.stringify({ ...status(), state: "failed", progress: {
    startedAt: new Date().toISOString(), phaseStartedAt: new Date().toISOString(),
    service: "app", completed: 0, total: 1, startup: "manual_recovery",
  } }) });
  for (const action of ["check", "update"]) {
    await assert.rejects(runAsPrincipal(manager, () => requestUpdaterCommand(action)), /UPDATER_RECOVERY_REQUIRED/);
  }
  assert.equal(rows.has("updater_command"), false);
  assert.equal(recordedPrisma.called("gatewayAuditLog", "create").length, 0);
});
