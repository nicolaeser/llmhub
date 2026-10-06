import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { retentionCutoff } from "@/worker/retention";

const root = fileURLToPath(new URL("..", import.meta.url));

test("request log retention is independent of spend and audit", async () => {
  const source = await readFile(
    path.join(root, "src/worker/jobs.ts"),
    "utf8",
  );
  assert.match(source, /spend_retention_days/);
  assert.match(source, /audit_retention_days/);
  assert.match(source, /log_retention_days/);
  const requestBlock = source.slice(
    source.indexOf("logCutoff"),
    source.indexOf("spendCutoff"),
  );
  assert.match(requestBlock, /requestLog\.deleteMany/);
  assert.doesNotMatch(requestBlock, /spendEvent\.deleteMany/);
  assert.doesNotMatch(requestBlock, /gatewayAuditLog\.deleteMany/);
});

test("retentionCutoff still disables at 0", () => {
  const now = new Date("2026-09-09T00:00:00.000Z");
  assert.equal(retentionCutoff(0, now), null);
});
