import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { toCsv } from "@/lib/export/csv";
import { CHARGEBACK_COLUMNS } from "@/lib/usage/usage-stats";
import type { AuthenticatedSession, Permission } from "@/types/auth";

const root = fileURLToPath(new URL("../..", import.meta.url));
const route = path.join(root, "src/app/internal-api/usage/chargeback/route.ts");
const misplaced = path.join(root, "src/app/api/mgmt/usage/chargeback/route.ts");
const DAY_MS = 86_400_000;

type Call = { model: string; method: string; args: unknown };
const calls: Call[] = [];

const usageRow = {
  day: new Date("2026-10-10T00:00:00Z"),
  keyId: "k1",
  teamId: "t1",
  orgId: "o1",
  projectId: "p1",
  memberId: "",
  userId: "u1",
  model: "gpt",
  requests: 2,
  errors: 0,
  rateLimited: 0,
  latencyMs: 10,
  promptTokens: 10,
  completionTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 1.5,
  cacheSavings: 0,
  purchaseCost: 1,
};

const names: Record<string, unknown[]> = {
  organization: [{ id: "o1", alias: "Acme" }],
  team: [{ id: "t1", alias: "IT" }],
};

(globalThis as { prisma?: unknown }).prisma = new Proxy(
  {},
  {
    get: (_client, model: string) =>
      new Proxy(
        {},
        {
          get: (_delegate, method: string) => async (args: unknown) => {
            calls.push({ model, method, args });
            if (method === "count") return 0;
            if (method !== "findMany") return null;
            if (model === "usageDaily") return [usageRow];
            return names[model] ?? [];
          },
        },
      ),
  },
);

function principal(permissions: Permission[]): AuthenticatedSession {
  return {
    error: false,
    sessionId: "",
    user: { id: "u1", username: "finance", orgId: null } as AuthenticatedSession["user"],
    isOwner: false,
    role: null,
    permissions,
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

async function exportAs(permissions: Permission[], query: string): Promise<Response> {
  const { runAsPrincipal } = await import("@/lib/auth/delegation");
  const { GET } = await import("@/app/internal-api/usage/chargeback/route");
  calls.length = 0;
  return runAsPrincipal(principal(permissions), () =>
    GET(new NextRequest(`http://hub.local/internal-api/usage/chargeback${query}`)),
  );
}

test("chargeback CSV lives under internal-api, not the management API", () => {
  assert.equal(existsSync(route), true);
  assert.equal(
    existsSync(misplaced),
    false,
    "chargeback must live under src/app/internal-api not src/app/api/mgmt",
  );
});

test("the chargeback export downloads the caller's filtered usage as a CSV attachment", async () => {
  const res = await exportAs(["spend:read"], "?days=7&teamId=t1");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="llmhub-chargeback.csv"');
  const [header, row] = (await res.text()).split("\n");
  assert.equal(header, CHARGEBACK_COLUMNS.join(","));
  assert.equal(row, "o1,Acme,t1,IT,p1,,,,k1,u1,gpt,1.5,10,5");
  const query = calls.find((call) => call.model === "usageDaily" && call.method === "findMany");
  const where = (query?.args as { where: { teamId?: string; userId?: string; day: { gte: Date } } }).where;
  assert.equal(where.teamId, "t1");
  assert.equal(where.userId, "u1");
  const windowMs = Date.now() - where.day.gte.getTime();
  assert.ok(windowMs >= 6 * DAY_MS && windowMs < 7 * DAY_MS + 60_000, `${windowMs}`);
});

test("the chargeback export answers 403 without spend access and reads no usage", async () => {
  const res = await exportAs(["keys:read"], "");
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  assert.equal((await res.json()).code, "FORBIDDEN");
  assert.deepEqual(calls, []);
});

test("toCsv writes a chargeback row", () => {
  const csv = toCsv([
    {
      org_id: "o1",
      team_id: "t1",
      project_id: "p1",
      key_id: "k1",
      user_id: "u1",
      model: "gpt",
      spend: 1.5,
      prompt_tokens: 10,
      completion_tokens: 5,
    },
  ]);
  assert.match(
    csv,
    /^org_id,team_id,project_id,key_id,user_id,model,spend,prompt_tokens,completion_tokens\n/,
  );
  assert.match(csv, /o1,t1,p1,k1,u1,gpt,1\.5,10,5\n/);
});
