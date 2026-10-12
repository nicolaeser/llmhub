import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { AuthError } from "@/lib/auth/errors";
import { deleteReport, saveReport, sendReportNow } from "@/lib/reports/manage";
import { loadStructure } from "@/lib/tenancy/structure";
import type { Permission } from "@/types/auth";
import { closeDatabase } from "./support/database";
import { sessionOf, TestData } from "./support/fixtures";

after(closeDatabase);

const REPORTER: Permission[] = ["budgets:manage", "spend:read-all", "tenancy:read"];
const failsWith = (code: string) => (err: unknown) => err instanceof Error && err.message === code;

const reportInput = (orgId: string, overrides: Record<string, unknown> = {}) => ({
  orgId,
  cadence: "weekly",
  format: "csv",
  locale: "en",
  recipients: ["finance@example.test"],
  ...overrides,
});

test("report actions need budgets:manage and spend:read-all", async () => {
  const data = new TestData();
  try {
    const org = await data.org();
    const report = await prisma.usageReport.create({ data: { orgId: org.id, recipients: ["a@example.test"] } });
    const spendOnly = sessionOf(await data.user(), { permissions: ["spend:read-all", "tenancy:read"] });
    const budgetOnly = sessionOf(await data.user(), { permissions: ["budgets:manage", "tenancy:read"] });

    for (const call of [
      () => saveReport(reportInput(org.id)),
      () => deleteReport(report.id),
      () => sendReportNow(report.id),
    ]) {
      await assert.rejects(runAsPrincipal(spendOnly, call), (err: unknown) => err instanceof AuthError && err.code === "FORBIDDEN");
      await assert.rejects(runAsPrincipal(budgetOnly, call), failsWith("FORBIDDEN"));
    }
    assert.equal(await prisma.usageReport.count({ where: { orgId: org.id } }), 1);

    const reporter = sessionOf(await data.user(), { permissions: REPORTER });
    const saved = await runAsPrincipal(reporter, () => saveReport(reportInput(org.id)));
    assert.ok(saved.reports.some((row) => row.orgId === org.id && row.cadence === "weekly"));
    await assert.rejects(runAsPrincipal(reporter, () => sendReportNow(report.id)), failsWith("MAIL_DISABLED"));
  } finally {
    await data.cleanup();
  }
});

test("reports stay inside the caller's company and its departments", async () => {
  const data = new TestData();
  try {
    const home = await data.org();
    const away = await data.org();
    const awayTeam = await data.team(away.id);
    const awayReport = await prisma.usageReport.create({ data: { orgId: away.id, recipients: ["a@example.test"] } });
    const manager = sessionOf(await data.user({ orgId: home.id }), { permissions: REPORTER });
    const as = <T>(fn: () => Promise<T>) => runAsPrincipal(manager, fn);

    await assert.rejects(as(() => saveReport(reportInput(away.id))), failsWith("ORG_NOT_FOUND"));
    await assert.rejects(as(() => saveReport(reportInput(home.id, { teamId: awayTeam.id }))), failsWith("TEAM_NOT_IN_ORG"));
    await assert.rejects(as(() => saveReport(reportInput(home.id, { id: awayReport.id }))), failsWith("NOT_FOUND"));
    await assert.rejects(as(() => deleteReport(awayReport.id)), failsWith("NOT_FOUND"));
    await assert.rejects(as(() => sendReportNow(awayReport.id)), failsWith("NOT_FOUND"));
    assert.equal(await prisma.usageReport.count({ where: { id: awayReport.id } }), 1);

    const saved = await as(() => saveReport(reportInput(home.id)));
    assert.deepEqual([...new Set(saved.reports.map((row) => row.orgId))], [home.id]);
    const structure = await as(() => loadStructure());
    assert.deepEqual(structure.reports.map((row) => row.orgId), [home.id]);
    assert.equal(structure.canReport, true);
  } finally {
    await data.cleanup();
  }
});

test("the structure lists reports only for users who see all spend", async () => {
  const data = new TestData();
  try {
    const org = await data.org();
    await prisma.usageReport.create({ data: { orgId: org.id, recipients: ["a@example.test"] } });
    const viewer = sessionOf(await data.user({ orgId: org.id }), { permissions: ["tenancy:read", "budgets:manage", "spend:read"] });
    const finance = sessionOf(await data.user({ orgId: org.id }), { permissions: ["tenancy:read", "spend:read-all"] });

    const hidden = await runAsPrincipal(viewer, () => loadStructure());
    assert.deepEqual(hidden.reports, []);
    assert.equal(hidden.canSeeReports, false);
    assert.equal(hidden.canReport, false);

    const shown = await runAsPrincipal(finance, () => loadStructure());
    assert.equal(shown.reports.length, 1);
    assert.equal(shown.canSeeReports, true);
    assert.equal(shown.canReport, false);
  } finally {
    await data.cleanup();
  }
});
