import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { after, test } from "node:test";
import { Client } from "pg";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { adoptRetentionDefaults, RETENTION_DEFAULTS_ADOPTED } from "@/lib/bootstrap/retention-defaults";
import { getEnterprise, normalizeEnterprise } from "@/lib/settings/enterprise";
import { saveGeneralSettings } from "@/lib/settings/general";
import { loadLogging, saveLogging } from "@/lib/settings/logging-alerts";
import { runRetentionSweep } from "@/worker/retention-sweep";
import type { LoggingSettingsView } from "@/types/settings";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting, sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const DAY_MS = 86_400_000;
const NOW = new Date("2000-03-01T12:00:00.000Z");
const MIGRATIONS = new URL("../../../prisma/migrations/", import.meta.url);

function ago(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function dayAgo(days: number): Date {
  const at = ago(days);
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

async function retentionDefaultsSql(): Promise<string> {
  const folder = (await readdir(MIGRATIONS)).find((name) => name.endsWith("_retention_defaults"));
  assert.ok(folder, "retention defaults migration");
  return readFile(new URL(`${folder}/migration.sql`, MIGRATIONS), "utf8");
}

async function migrateEnterprise(value: string, loggingSaved: boolean): Promise<string | null> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM "GatewayAuditLog" WHERE "action" = 'settings.logging'`);
    if (loggingSaved) {
      await client.query(
        `INSERT INTO "GatewayAuditLog" ("id", "actor", "action", "objectType", "objectId") VALUES ($1, 'it', 'settings.logging', 'enterprise', 'enterprise')`,
        [uniqueName("audit")],
      );
    }
    await client.query(
      `INSERT INTO "Setting" ("key", "value") VALUES ('enterprise', $1) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      [value],
    );
    await client.query(await retentionDefaultsSql());
    const { rows } = await client.query<{ value: string }>(`SELECT "value" FROM "Setting" WHERE "key" = 'enterprise'`);
    return rows[0]?.value ?? null;
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

test("the retention migration gives never-chosen settings the new defaults and keeps explicit choices", async () => {
  const persistedDefaults = {
    cache_ttl_seconds: 0,
    log_retention_days: 0,
    spend_retention_days: 0,
    audit_retention_days: 0,
    object_retention_days: 30,
    file_retention_days: 0,
    content_retention_days: 0,
    log_content: true,
    registration_enabled: true,
  };
  const migrated = JSON.parse((await migrateEnterprise(JSON.stringify(persistedDefaults), false)) ?? "null");
  const unchosen: Record<string, unknown> = { ...persistedDefaults };
  delete unchosen.log_retention_days;
  delete unchosen.content_retention_days;
  assert.deepEqual(migrated, unchosen);
  assert.equal(normalizeEnterprise(migrated).log_retention_days, 7);
  assert.equal(normalizeEnterprise(migrated).content_retention_days, 7);

  const saved = await migrateEnterprise(JSON.stringify(persistedDefaults), true);
  assert.deepEqual(JSON.parse(saved ?? "null"), persistedDefaults);

  const chosen = { ...persistedDefaults, audit_retention_days: 365 };
  assert.deepEqual(JSON.parse((await migrateEnterprise(JSON.stringify(chosen), false)) ?? "null"), chosen);

  const boot = { cache_ttl_seconds: 0, pii: { enabled: true, mode: "mask", output: true } };
  const booted = JSON.parse((await migrateEnterprise(JSON.stringify(boot), false)) ?? "null");
  assert.deepEqual(booted, boot);
  assert.equal(normalizeEnterprise(booted).content_retention_days, 7);

  assert.equal(await migrateEnterprise("{not json", false), "{not json");
});

class RolledBack extends Error {}

async function adoptOnce(value: string, loggingSaved: boolean, adoptedBefore = false) {
  let outcome: { value: string | null; adopted: boolean } | null = null;
  await prisma
    .$transaction(async (tx) => {
      await tx.gatewayAuditLog.deleteMany({ where: { action: "settings.logging" } });
      if (loggingSaved) {
        await tx.gatewayAuditLog.create({
          data: { actor: "it", action: "settings.logging", objectType: "enterprise", objectId: "enterprise" },
        });
      }
      await tx.setting.deleteMany({ where: { key: RETENTION_DEFAULTS_ADOPTED } });
      if (adoptedBefore) await tx.setting.create({ data: { key: RETENTION_DEFAULTS_ADOPTED, value: "1" } });
      await tx.setting.upsert({ where: { key: "enterprise" }, update: { value }, create: { key: "enterprise", value } });
      await adoptRetentionDefaults(tx);
      await adoptRetentionDefaults(tx);
      outcome = {
        value: (await tx.setting.findUnique({ where: { key: "enterprise" } }))?.value ?? null,
        adopted: Boolean(await tx.setting.findUnique({ where: { key: RETENTION_DEFAULTS_ADOPTED } })),
      };
      throw new RolledBack();
    })
    .catch((error: unknown) => {
      if (!(error instanceof RolledBack)) throw error;
    });
  assert.ok(outcome);
  return outcome as { value: string | null; adopted: boolean };
}

test("boot moves never-chosen retention to 7 days and 5 GB once and keeps saved logging settings", async () => {
  const persisted = {
    cache_ttl_seconds: 0,
    log_retention_days: 30,
    content_retention_days: 30,
    content_max_gb: 0,
    security_retention_days: 90,
    object_retention_days: 30,
    registration_enabled: true,
  };
  const unchosen = await adoptOnce(JSON.stringify(persisted), false);
  assert.equal(unchosen.adopted, true);
  assert.deepEqual(JSON.parse(unchosen.value ?? "null"), {
    cache_ttl_seconds: 0,
    security_retention_days: 90,
    object_retention_days: 30,
    registration_enabled: true,
  });
  const effective = normalizeEnterprise(JSON.parse(unchosen.value ?? "null"));
  assert.deepEqual([effective.log_retention_days, effective.content_retention_days, effective.content_max_gb], [7, 7, 5]);

  const saved = await adoptOnce(JSON.stringify(persisted), true);
  assert.deepEqual([JSON.parse(saved.value ?? "null"), saved.adopted], [persisted, true]);

  const already = await adoptOnce(JSON.stringify(persisted), false, true);
  assert.deepEqual(JSON.parse(already.value ?? "null"), persisted);

  const broken = await adoptOnce("{not json", false);
  assert.deepEqual([broken.value, broken.adopted], ["{not json", true]);
});

test("saving the logging settings keeps an explicit 0 and unsaved values use the defaults", async () => {
  const data = new TestData();
  const restore = await preserveSetting("enterprise");
  try {
    await prisma.setting.deleteMany({ where: { key: "enterprise" } });
    const admin = sessionOf(await data.user(), { permissions: ["settings:read", "settings:manage"] });
    const fresh = await runAsPrincipal(admin, () => loadLogging());
    assert.deepEqual(retentionOf(fresh), { log: 7, content: 7, security: 90, spend: 0, usage: 0, audit: 0 });
    assert.equal(fresh.contentMaxGb, 5);

    const saved = await runAsPrincipal(admin, () =>
      saveLogging({
        alertWebhooks: [],
        alertRules: fresh.alertRules,
        alertEmails: fresh.alertEmails,
        logRetentionDays: 0,
        spendRetentionDays: 0,
        usageRetentionDays: 400,
        auditRetentionDays: 0,
        securityRetentionDays: 0,
        objectRetentionDays: fresh.objectRetentionDays,
        fileRetentionDays: fresh.fileRetentionDays,
        contentRetentionDays: 0,
        logArchive: false,
        logContent: true,
      }),
    );
    assert.deepEqual(retentionOf(saved), { log: 0, content: 0, security: 0, spend: 0, usage: 400, audit: 0 });

    await runAsPrincipal(admin, () => saveGeneralSettings({ registration_enabled: false, update_check: true }));
    const enterprise = await getEnterprise();
    assert.deepEqual(
      [enterprise.log_retention_days, enterprise.content_retention_days, enterprise.security_retention_days],
      [0, 0, 0],
    );
  } finally {
    await restore();
    await data.cleanup();
  }
});

function retentionOf(view: LoggingSettingsView) {
  return {
    log: view.logRetentionDays,
    content: view.contentRetentionDays,
    security: view.securityRetentionDays,
    spend: view.spendRetentionDays,
    usage: view.usageRetentionDays,
    audit: view.auditRetentionDays,
  };
}

async function requestLog(tag: string, days: number) {
  return prisma.requestLog.create({
    data: { tag, createdAt: ago(days), contents: { create: { request: { tag }, createdAt: ago(days) } } },
  });
}

async function removeFixtures(tag: string) {
  await prisma.requestLog.deleteMany({ where: { tag } });
  await prisma.toolExecution.deleteMany({ where: { correlationId: tag } });
  await prisma.approvalRequest.deleteMany({ where: { subjectId: tag } });
  await prisma.gatewayAuditLog.deleteMany({ where: { objectId: tag } });
  await prisma.spendEvent.deleteMany({ where: { tag } });
  await prisma.usageDaily.deleteMany({ where: { keyId: tag } });
}

test("the sweep deletes expired rows in chunks across tables and keeps recent and load-bearing ones", async () => {
  const data = new TestData();
  const tag = uniqueName("retention");
  const user = await data.user();
  try {
    await Promise.all([requestLog(tag, 40), requestLog(tag, 41), requestLog(tag, 42)]);
    const contentOnly = await requestLog(tag, 10);
    const recent = await requestLog(tag, 1);
    await prisma.userSecurityEvent.createMany({
      data: [100, 101, 102, 10].map((days) => ({
        userId: user.id,
        actor: "system",
        action: "password.changed",
        ipAddress: "192.0.2.1",
        createdAt: ago(days),
      })),
    });
    await prisma.toolExecution.createMany({
      data: [40, 41, 9, 1].map((days) => ({
        toolId: tag,
        actor: "it",
        correlationId: tag,
        decision: "allow",
        status: "succeeded",
        startedAt: ago(days),
      })),
    });
    await prisma.approvalRequest.createMany({
      data: [
        { status: "rejected", decidedAt: ago(400) },
        { status: "rejected", decidedAt: ago(10) },
        { status: "approved", decidedAt: ago(400) },
        { status: "pending", decidedAt: null },
      ].map((row) => ({ ...row, kind: "publish", subjectType: "tool", subjectId: tag, requestedBy: "it", createdAt: ago(500) })),
    });
    await prisma.gatewayAuditLog.createMany({
      data: [400, 10].map((days) => ({ actor: "it", action: "it.retention", objectType: "it", objectId: tag, createdAt: ago(days) })),
    });
    await prisma.spendEvent.createMany({ data: [400, 10].map((days) => ({ tag, createdAt: ago(days) })) });
    await prisma.usageDaily.createMany({
      data: [800, 731, 10].map((days) => ({ day: dayAgo(days), keyId: tag })),
    });

    const settings = normalizeEnterprise({
      log_retention_days: 30,
      content_retention_days: 7,
      security_retention_days: 90,
      spend_retention_days: 365,
      audit_retention_days: 365,
      usage_retention_days: 730,
    });
    const run = await runRetentionSweep(settings, NOW, { chunk: 2, leaseKey: uniqueName("lease") });
    assert.ok(run);
    assert.deepEqual(run.backlog, []);

    const logs = await prisma.requestLog.findMany({ where: { tag }, include: { contents: true } });
    assert.deepEqual(
      logs.map((row) => [row.id, row.contents.length > 0]).sort(),
      [
        [contentOnly.id, false],
        [recent.id, true],
      ].sort(),
    );
    const events = await prisma.userSecurityEvent.findMany({ where: { userId: user.id } });
    assert.deepEqual(events.map((row) => row.createdAt.toISOString()), [ago(10).toISOString()]);
    const executions = await prisma.toolExecution.findMany({ where: { correlationId: tag }, orderBy: { startedAt: "asc" } });
    assert.deepEqual(executions.map((row) => row.startedAt.toISOString()), [ago(1).toISOString()]);
    const approvals = await prisma.approvalRequest.findMany({ where: { subjectId: tag } });
    assert.deepEqual(approvals.map((row) => `${row.status}:${row.decidedAt?.toISOString() ?? ""}`).sort(), [
      `approved:${ago(400).toISOString()}`,
      "pending:",
      `rejected:${ago(10).toISOString()}`,
    ]);
    const audits = await prisma.gatewayAuditLog.findMany({ where: { objectId: tag } });
    assert.deepEqual(audits.map((row) => row.createdAt.toISOString()), [ago(10).toISOString()]);
    const spend = await prisma.spendEvent.findMany({ where: { tag } });
    assert.deepEqual(spend.map((row) => row.createdAt.toISOString()), [ago(10).toISOString()]);
    assert.equal(await prisma.usageDaily.count({ where: { keyId: tag } }), 1);
  } finally {
    await removeFixtures(tag);
    await data.cleanup();
  }
});

test("a sweep stops at its time budget, keeps a backlog, and the next sweep continues", async () => {
  const data = new TestData();
  const user = await data.user();
  const leaseKey = uniqueName("lease");
  try {
    await prisma.userSecurityEvent.createMany({
      data: [91, 92, 93, 94, 95].map((days) => ({
        userId: user.id,
        actor: "system",
        action: "sessions.revoked",
        createdAt: ago(days),
      })),
    });
    const settings = normalizeEnterprise({ log_retention_days: 0, content_retention_days: 0, security_retention_days: 90 });
    let tick = 0;
    const first = await runRetentionSweep(settings, NOW, { chunk: 2, budgetMs: 3, clock: () => tick++, leaseKey });
    assert.deepEqual(first, { deleted: { securityEvents: 2 }, backlog: ["securityEvents"] });
    assert.equal(await prisma.setting.findUnique({ where: { key: leaseKey } }), null);

    const rest = await runRetentionSweep(settings, NOW, { chunk: 2, leaseKey });
    assert.deepEqual(rest?.backlog, []);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("only the replica holding the retention lease cleans up", async () => {
  const data = new TestData();
  const user = await data.user();
  const leaseKey = uniqueName("lease");
  try {
    await prisma.userSecurityEvent.create({
      data: { userId: user.id, actor: "system", action: "sessions.revoked", createdAt: ago(120) },
    });
    const settings = normalizeEnterprise({ log_retention_days: 0, content_retention_days: 0 });
    const token = await acquireLease(leaseKey, 60_000);
    assert.ok(token);
    assert.equal(await runRetentionSweep(settings, NOW, { leaseKey }), null);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id } }), 1);

    await releaseLease(leaseKey, token);
    const run = await runRetentionSweep(settings, NOW, { leaseKey });
    assert.ok(run);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.setting.findUnique({ where: { key: leaseKey } }), null);
  } finally {
    await prisma.setting.deleteMany({ where: { key: leaseKey } });
    await data.cleanup();
  }
});
