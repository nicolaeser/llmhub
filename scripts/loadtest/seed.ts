import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import prisma from "@/lib/db/prisma";
import { createFirstAdmin } from "@/lib/bootstrap/first-admin";
import { permissions } from "@/lib/auth/permissions";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { saveMember, saveOrg, saveTeam } from "@/lib/tenancy/structure";
import { setBudget } from "@/lib/tenancy/budgets";
import { createProvider } from "@/lib/providers/connections";
import { importUploads } from "@/lib/providers/auth-import";
import { createModelGroup } from "@/lib/models/groups";
import { createKey } from "@/lib/keys/manage";
import type { AuthenticatedSession } from "@/types/auth";
import type { DeploymentInput } from "@/types/models";

const { values: args } = parseArgs({
  options: {
    mock: { type: "string", default: "http://127.0.0.1:55438" },
    accounts: { type: "string", default: "4" },
    members: { type: "string", default: "20" },
    model: { type: "string", default: "claude-load" },
    upstream: { type: "string", default: "claude-opus-5-5" },
    out: { type: "string", default: "loadtest-state.json" },
  },
});

const ACCOUNT_TTL_MS = 8 * 3_600_000;
const COST_INPUT_PER_1K = 0.005;
const COST_OUTPUT_PER_1K = 0.025;

function ownerSession(user: AuthenticatedSession["user"]): AuthenticatedSession {
  return {
    error: false,
    sessionId: `loadtest-seed-${randomBytes(6).toString("hex")}`,
    user,
    isOwner: true,
    role: null,
    permissions: [...permissions],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
  };
}

function claudeAuthFile(label: string) {
  return {
    name: `claude-${label}.json`,
    content: JSON.stringify({
      type: "claude",
      email: `${label}@loadtest.invalid`,
      access_token: `loadtest-${label}-access-${randomBytes(12).toString("hex")}`,
      refresh_token: `loadtest-${label}-refresh-${randomBytes(12).toString("hex")}`,
      expired: new Date(Date.now() + ACCOUNT_TTL_MS).toISOString(),
    }),
  };
}

function deployment(kind: string, providerId: string): DeploymentInput {
  return {
    kind,
    baseUrl: "",
    model: args.upstream,
    weight: 1,
    costInput: COST_INPUT_PER_1K,
    costOutput: COST_OUTPUT_PER_1K,
    providerId,
  };
}

async function seedAdmin() {
  const username = "loadadmin";
  const setup = await createFirstAdmin({
    username,
    email: `${username}@loadtest.invalid`,
    password: `Lt-${randomBytes(18).toString("base64url")}`,
  });
  if (!setup.ok) throw new Error(`first admin: ${setup.error}`);
  return prisma.user.findFirstOrThrow({ where: { username } });
}

async function seedStructure(memberCount: number) {
  const orgs = await saveOrg({ alias: "Loadtest Company" });
  const org = orgs.orgs.find((row) => row.alias === "Loadtest Company")!;
  const teamIds: string[] = [];
  for (const alias of ["Platform", "Product"]) {
    const structure = await saveTeam({ alias, orgId: org.id, rpm: 0, tpm: 0 });
    teamIds.push(structure.teams.find((row) => row.alias === alias && row.orgId === org.id)!.id);
  }
  const memberIds: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const alias = `Developer ${i + 1}`;
    const structure = await saveMember({
      alias,
      email: `dev${i + 1}@loadtest.invalid`,
      orgId: org.id,
      teamId: teamIds[i % teamIds.length]!,
      blocked: false,
      logContent: true,
    });
    memberIds.push(structure.members.find((row) => row.alias === alias)!.id);
  }
  await setBudget({ kind: "org", id: org.id, maxBudget: 1_000_000, budgetDuration: "monthly" });
  for (const id of teamIds) await setBudget({ kind: "team", id, maxBudget: 500_000, budgetDuration: "monthly" });
  return { orgId: org.id, teamIds, memberIds };
}

async function seedProviders(accountCount: number) {
  const api = await createProvider({ name: "Mock Anthropic API", kind: "anthropic", baseUrl: args.mock, apiKey: "loadtest-api-key" });
  const files = Array.from({ length: accountCount }, (_, i) => claudeAuthFile(`acct${i + 1}`));
  const imported = await importUploads("loadtest", files);
  const failed = imported.results.filter((result) => result.status === "failed");
  if (failed.length) throw new Error(`claude import failed: ${JSON.stringify(failed)}`);
  return { apiId: api.provider.id, accounts: imported.providers.map((provider) => ({ id: provider.id, account: provider.signIn?.account ?? "" })) };
}

async function main() {
  const user = await seedAdmin();
  const seeded = await runAsPrincipal(ownerSession(user), async () => {
    const structure = await seedStructure(Number(args.members));
    const providers = await seedProviders(Number(args.accounts));
    await createModelGroup({
      alias: args.model,
      strategy: "least_inflight",
      autoRoutes: false,
      numRetries: 1,
      overflowGroup: "",
      fallbackGroups: [],
      deployments: [
        deployment("anthropic", providers.apiId),
        ...providers.accounts.map((account) => deployment("claude", account.id)),
      ],
    });
    const keys: { id: string; memberId: string; key: string }[] = [];
    for (const [index, memberId] of structure.memberIds.entries()) {
      const created = await createKey({ alias: `loadtest-dev-${index + 1}`, memberId });
      keys.push({ id: created.key.token_id, memberId, key: created.key.key });
    }
    return { ...structure, ...providers, keys };
  });
  writeFileSync(args.out, `${JSON.stringify({ model: args.model, mock: args.mock, ...seeded }, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ out: args.out, keys: seeded.keys.length, accounts: seeded.accounts.length, model: args.model }));
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
