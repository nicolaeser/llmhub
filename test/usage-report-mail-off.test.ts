import assert from "node:assert/strict";
import test from "node:test";

const touched: string[] = [];

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_target, model: string) =>
      new Proxy(
        {},
        {
          get: (_inner, method: string) => async () => {
            touched.push(`${model}.${method}`);
            return [];
          },
        },
      ),
  },
);
delete process.env.SMTP_URL;

test("report delivery sends nothing and claims nothing while mail is disabled", async () => {
  const { runUsageReports } = await import("@/lib/reports/usage-report");
  assert.equal(await runUsageReports(new Date("2026-10-07T12:00:00Z")), 0);
  assert.deepEqual(touched, []);
});
