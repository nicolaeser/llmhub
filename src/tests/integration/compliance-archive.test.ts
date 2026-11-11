import "./support/s3-env";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, afterEach, test } from "node:test";
import { gunzipSync } from "node:zlib";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { archiveRetentionHolds } from "@/lib/compliance-archive/holds";
import { ARCHIVE_LEASE, runComplianceArchive } from "@/lib/compliance-archive/runner";
import { DEFAULT_COMPLIANCE_ARCHIVE } from "@/lib/compliance-archive/settings";
import { acquireLease, releaseLease } from "@/lib/jobs/lease";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import { loadComplianceArchive, saveComplianceArchive } from "@/lib/settings/compliance-archive";
import { runRetentionSweep } from "@/worker/retention-sweep";
import type { ArchiveManifest, ComplianceArchiveInput } from "@/types/archive";
import { closeDatabase, uniqueName } from "./support/database";
import { preserveSetting, sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NOW = new Date("2000-03-01T12:00:00.000Z");
const STORAGE = {
  preset: "custom" as const,
  bucket: "it-archive-bucket",
  region: "us-east-1",
  endpoint: "https://s3.archive.test",
  prefix: "llmhub",
  addressing: "path" as const,
  public_base_url: "",
};

type FakeS3 = { objects: Map<string, Buffer>; deletes: string[]; deny: { on: boolean } };

function fakeS3(): FakeS3 {
  const objects = new Map<string, Buffer>();
  const uploads = new Map<string, Buffer[]>();
  const deletes: string[] = [];
  const deny = { on: false };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const key = decodeURIComponent(url.pathname).replace(/^\/it-archive-bucket\//, "");
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    if (deny.on) return new Response("<Error><Code>AccessDenied</Code><Message>no</Message></Error>", { status: 403 });
    if (method === "POST" && url.searchParams.has("uploads")) {
      const id = uniqueName("upload");
      uploads.set(id, []);
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    const uploadId = url.searchParams.get("uploadId");
    if (method === "PUT" && uploadId) {
      uploads.get(uploadId)?.push(body);
      return new Response(null, { headers: { etag: `"${url.searchParams.get("partNumber")}"` } });
    }
    if (method === "POST" && uploadId) {
      objects.set(key, Buffer.concat(uploads.get(uploadId) ?? []));
      return new Response("<CompleteMultipartUploadResult></CompleteMultipartUploadResult>");
    }
    if (method === "PUT") {
      objects.set(key, body);
      return new Response(null);
    }
    if (method === "DELETE") {
      deletes.push(key);
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const stored = objects.get(key);
    return stored ? new Response(new Uint8Array(stored)) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
  }) as typeof fetch;
  return { objects, deletes, deny };
}

async function auditRows(actor: string, times: string[]) {
  for (const at of times) {
    await prisma.gatewayAuditLog.create({
      data: { actor, action: "it.archive", objectType: "test", objectId: uniqueName("object"), afterJson: '{"n":1}', createdAt: new Date(at) },
    });
  }
}

async function cleanupRuns() {
  await prisma.complianceArchiveRun.deleteMany({ where: { day: { lt: day("2001-01-01") } } });
}

test("the daily archive exports closed days, holds database retention, retries failures, and expires old archives", async () => {
  const restore = await preserveSetting("enterprise");
  const actor = uniqueName("archive-actor");
  const s3 = fakeS3();
  await cleanupRuns();
  try {
    await patchEnterprise({
      s3: STORAGE,
      audit_retention_days: 1,
      compliance_archive: {
        ...DEFAULT_COMPLIANCE_ARCHIVE,
        enabled: true,
        datasets: ["audit"],
        format: "jsonl_gzip",
        prefix: "it-archive",
      },
    });
    await auditRows(actor, [
      "2000-02-28T08:00:00Z",
      "2000-02-28T09:00:00Z",
      "2000-02-28T23:59:59Z",
      "2000-02-29T00:00:00Z",
      "2000-02-29T10:00:00Z",
      "2000-03-01T09:00:00Z",
    ]);
    await prisma.complianceArchiveRun.create({ data: { dataset: "audit", day: day("2000-02-27"), status: "done" } });

    assert.deepEqual(await archiveRetentionHolds(await getEnterprise()), { auditLogs: day("2000-02-28") });
    await runRetentionSweep(await getEnterprise(), NOW, {
      leaseKey: uniqueName("lease"),
      holds: await archiveRetentionHolds(await getEnterprise()),
    });
    assert.equal(await prisma.gatewayAuditLog.count({ where: { actor } }), 6, "retention waits for the archive");

    const tick = await runComplianceArchive(NOW);
    assert.equal(tick.planned, 2);
    assert.equal(tick.exported, 2);
    assert.equal(tick.failed, 0);
    const runs = await prisma.complianceArchiveRun.findMany({ where: { dataset: "audit", day: { gte: day("2000-02-28"), lt: day("2000-03-01") } }, orderBy: { day: "asc" } });
    assert.deepEqual(runs.map((run) => [run.status, run.format]), [["done", "jsonl_gzip"], ["done", "jsonl_gzip"]]);
    assert.equal(runs[0].objectKey, "llmhub/it-archive/audit/2000/02/audit-2000-02-28.jsonl.gz");
    assert.equal(runs[0].manifestKey, "llmhub/it-archive/audit/2000/02/audit-2000-02-28.manifest.json");

    const object = s3.objects.get(runs[0].objectKey);
    assert.ok(object, "archive object");
    const lines = gunzipSync(object).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const mine = lines.filter((line) => line.actor === actor);
    assert.deepEqual(mine.map((line) => line.created_at), ["2000-02-28T08:00:00.000Z", "2000-02-28T09:00:00.000Z", "2000-02-28T23:59:59.000Z"]);
    assert.deepEqual(mine[0].after, { n: 1 });
    assert.equal(runs[0].rows, lines.length);
    assert.equal(runs[0].sha256, createHash("sha256").update(object).digest("hex"));
    const manifest = JSON.parse(s3.objects.get(runs[0].manifestKey)!.toString("utf8")) as ArchiveManifest;
    assert.equal(manifest.sha256, runs[0].sha256);
    assert.equal(manifest.records, lines.length);
    assert.equal(manifest.object, runs[0].objectKey);
    assert.equal(manifest.from, "2000-02-28T00:00:00.000Z");
    assert.equal(manifest.to, "2000-02-29T00:00:00.000Z");

    assert.deepEqual(await archiveRetentionHolds(await getEnterprise()), { auditLogs: day("2000-03-01") });

    const token = await acquireLease(ARCHIVE_LEASE, 60_000);
    assert.ok(token);
    try {
      assert.equal((await runComplianceArchive(NOW)).skipped, "busy");
    } finally {
      await releaseLease(ARCHIVE_LEASE, token);
    }

    await prisma.complianceArchiveRun.update({ where: { id: runs[1].id }, data: { status: "pending", nextAttemptAt: NOW } });
    s3.deny.on = true;
    const failing = await runComplianceArchive(NOW);
    assert.equal(failing.failed, 1);
    const failed = await prisma.complianceArchiveRun.findUniqueOrThrow({ where: { id: runs[1].id } });
    assert.deepEqual([failed.status, failed.error, failed.attempts], ["failed", "DENIED", 2]);
    assert.ok(failed.nextAttemptAt > new Date());
    assert.deepEqual(await archiveRetentionHolds(await getEnterprise()), { auditLogs: day("2000-02-29") });

    s3.deny.on = false;
    await patchEnterprise({ compliance_archive: { ...(await getEnterprise()).compliance_archive!, retention_days: 1 } });
    const later = await runComplianceArchive(new Date("2000-03-10T12:00:00Z"));
    assert.ok(later.expired >= 2);
    const expired = await prisma.complianceArchiveRun.findUniqueOrThrow({ where: { id: runs[0].id } });
    assert.equal(expired.status, "expired");
    assert.ok(expired.expiredAt);
    assert.equal(s3.objects.has(runs[0].objectKey), false);
    assert.ok(s3.deletes.includes(runs[0].manifestKey));
    assert.equal((await prisma.complianceArchiveRun.findUniqueOrThrow({ where: { id: runs[1].id } })).status, "failed");
  } finally {
    await prisma.gatewayAuditLog.deleteMany({ where: { actor } });
    await cleanupRuns();
    await restore();
  }
});

test("archive settings need settings:manage, keep the password sealed, and require storage", async () => {
  const data = new TestData();
  const restore = await preserveSetting("enterprise");
  fakeS3();
  try {
    await patchEnterprise({ s3: { ...STORAGE, bucket: "" }, compliance_archive: DEFAULT_COMPLIANCE_ARCHIVE });
    const reader = sessionOf(await data.user(), { permissions: ["settings:read"] });
    const manager = sessionOf(await data.user(), { permissions: ["settings:read", "settings:manage"] });
    const input: ComplianceArchiveInput = {
      enabled: false,
      datasets: ["requests", "security"],
      format: "zip_aes",
      password: "a very long archive password",
      clearPassword: false,
      include_content: false,
      bucket: "",
      prefix: "audits/llmhub",
      retention_days: 0,
      lock_mode: "none",
    };
    await assert.rejects(
      runAsPrincipal(reader, () => saveComplianceArchive(input)),
      (err) => err instanceof AuthError && err.code === "FORBIDDEN",
    );
    await assert.rejects(runAsPrincipal(manager, () => saveComplianceArchive({ ...input, enabled: true })), /ARCHIVE_STORAGE_REQUIRED/);

    const saved = await runAsPrincipal(manager, () => saveComplianceArchive(input));
    assert.equal(saved.passwordSet, true);
    assert.equal("password" in saved.settings, false);
    assert.equal(saved.settings.prefix, "audits/llmhub");
    const stored = (await prisma.setting.findUniqueOrThrow({ where: { key: "enterprise" } })).value;
    assert.equal(stored.includes("a very long archive password"), false);
    assert.match(JSON.parse(stored).compliance_archive.password, /^enc1:/);
    assert.equal((await getEnterprise()).compliance_archive?.password, "a very long archive password");
    const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { actor: manager.user.id, action: "settings.compliance_archive" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(audit.afterJson.includes("a very long archive password"), false);
    assert.equal(JSON.parse(audit.afterJson).passwordChanged, true);

    const kept = await runAsPrincipal(manager, () => saveComplianceArchive({ ...input, password: "" }));
    assert.equal(kept.passwordSet, true);
    await assert.rejects(runAsPrincipal(manager, () => saveComplianceArchive({ ...input, password: "", clearPassword: true })), /ARCHIVE_PASSWORD_REQUIRED/);
    const loaded = await runAsPrincipal(reader, () => loadComplianceArchive());
    assert.equal(loaded.canManage, false);
    assert.equal(loaded.storage.ready, false);
  } finally {
    await restore();
    await data.cleanup();
  }
});
