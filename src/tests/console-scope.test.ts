import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runAsPrincipal } from "@/lib/auth/delegation";
import { permissions } from "@/lib/auth/permissions";
import type { AuthenticatedSession } from "@/types/auth";
import type { WorkspaceChange } from "@/types/console";
import { importedAs, readJsx, type JsxNode } from "./support/jsx-source";

const root = fileURLToPath(new URL("../..", import.meta.url));

const COMPANY_ID = "orgacme0001";

function principal(options: { isOwner?: boolean; workspaceOrgId?: string | null; orgId?: string | null } = {}): AuthenticatedSession {
  return {
    error: false,
    sessionId: "s1",
    user: { id: "u1", username: "owner", email: "owner@example.com", orgId: options.orgId ?? null } as AuthenticatedSession["user"],
    isOwner: options.isOwner ?? true,
    role: null,
    permissions: [...permissions],
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    workspaceOrgId: options.workspaceOrgId ?? null,
  };
}

const companyView = principal({ workspaceOrgId: COMPANY_ID });
const platform = principal();

const PII = { enabled: true, mode: "mask", output: true, entities: ["EMAIL_ADDRESS"] };
const GUARDRAILS = {
  rules: [],
  injection: { enabled: false, action: "flag" },
  secrets: { enabled: false, action: "flag" },
};

test("global policies, markups, settings, and console users refuse the company scope before reading data", async () => {
  const { savePii, saveGuardrailPolicy } = await import("@/lib/settings/guardrail-policies");
  const { deleteMarkup, loadMarkups, saveMarkup } = await import("@/lib/pricing/markups");
  const { saveGeneralSettings } = await import("@/lib/settings/general");
  const { saveLogging } = await import("@/lib/settings/logging-alerts");
  const { saveCache } = await import("@/lib/settings/caching");
  const { saveCatalogSettings } = await import("@/lib/settings/catalog");
  const { saveStorageSettings } = await import("@/lib/settings/storage");
  const { saveSignInSettings } = await import("@/lib/settings/sign-in");
  const { changeUsers, loadUsersConsole } = await import("@/lib/auth/users");
  const { changeRole, loadRolesConsole } = await import("@/lib/auth/roles");
  const { saveBudgetAlerts } = await import("@/lib/tenancy/budgets");
  const guarded: [string, () => Promise<unknown>][] = [
    ["savePii", () => savePii(PII)],
    ["saveGuardrailPolicy", () => saveGuardrailPolicy(GUARDRAILS)],
    ["loadMarkups", () => loadMarkups()],
    ["saveMarkup", () => saveMarkup({ scope: "all", targetId: "", model: "*", percent: 10, note: "" })],
    ["deleteMarkup", () => deleteMarkup("markup-1")],
    ["saveGeneralSettings", () => saveGeneralSettings({})],
    ["saveLogging", () => saveLogging({} as Parameters<typeof saveLogging>[0])],
    ["saveCache", () => saveCache({} as Parameters<typeof saveCache>[0])],
    ["saveCatalogSettings", () => saveCatalogSettings({})],
    ["saveStorageSettings", () => saveStorageSettings({})],
    ["saveSignInSettings", () => saveSignInSettings({})],
    ["loadUsersConsole", () => loadUsersConsole()],
    ["changeUsers", () => changeUsers("users:manage", async () => null)],
    ["loadRolesConsole", () => loadRolesConsole()],
    ["changeRole", () => changeRole(async () => ({ id: "r1" }))],
    ["saveBudgetAlerts", () => saveBudgetAlerts([50])],
  ];
  for (const [name, call] of guarded) {
    recordedPrisma.reset();
    await assert.rejects(runAsPrincipal(companyView, call), /PLATFORM_ONLY/, name);
    assert.deepEqual(recordedPrisma.calls, [], name);
  }
  const companyUser = principal({ isOwner: false, orgId: COMPANY_ID });
  await assert.rejects(runAsPrincipal(companyUser, () => savePii(PII)), /FORBIDDEN|PLATFORM_ONLY/);
});

test("the platform scope still saves the global PII policy", async () => {
  const { savePii } = await import("@/lib/settings/guardrail-policies");
  recordedPrisma.reset();
  const saved = await runAsPrincipal(platform, () => savePii(PII));
  assert.deepEqual(saved.pii, { ...PII, detector: "patterns", failure: "patterns" });
  assert.equal(recordedPrisma.called("setting", "upsert").length, 1);
});

test("guardrail overrides in the company scope only list and edit that company", async () => {
  const { loadGuardrails, savePolicyOverride } = await import("@/lib/settings/guardrail-policies");
  recordedPrisma.reset();
  const view = await runAsPrincipal(companyView, () => loadGuardrails());
  assert.equal(view.platform, false);
  assert.deepEqual(recordedPrisma.called("organization", "findMany")[0]?.args, {
    where: { id: COMPANY_ID },
    select: { id: true, alias: true },
    orderBy: { alias: "asc" },
  });
  assert.deepEqual((recordedPrisma.called("team", "findMany")[0]?.args as { where: unknown }).where, { orgId: COMPANY_ID });
  assert.deepEqual((recordedPrisma.called("project", "findMany")[0]?.args as { where: unknown }).where, { orgId: COMPANY_ID });
  assert.deepEqual((recordedPrisma.called("virtualKey", "findMany")[0]?.args as { where: unknown }).where, { orgId: COMPANY_ID });
  assert.deepEqual((recordedPrisma.called("policyOverride", "findMany")[0]?.args as { where: unknown }).where, {
    OR: [
      { orgId: COMPANY_ID },
      { team: { orgId: COMPANY_ID } },
      { project: { orgId: COMPANY_ID } },
      { key: { orgId: COMPANY_ID } },
    ],
  });

  recordedPrisma.reset({
    organization: { findUnique: () => ({ id: "orgother001", alias: "Other" }) },
    team: { findUnique: () => ({ id: "t1", alias: "Ops", orgId: "orgother001", org: { alias: "Other" } }) },
    project: {
      findUnique: () => ({ id: "p1", alias: "Bot", orgId: "orgother001", teamId: null, org: { alias: "Other" }, team: null }),
    },
  });
  for (const [scope, id] of [["org", "orgother001"], ["team", "t1"], ["project", "p1"]] as const) {
    await assert.rejects(
      runAsPrincipal(companyView, () =>
        savePolicyOverride({ scope, id, pii: PII, injection: null, secrets: null, rules: null }),
      ),
      /NOT_FOUND/,
      scope,
    );
  }
  assert.equal(recordedPrisma.called("policyOverride", "upsert").length, 0);

  recordedPrisma.reset();
  assert.equal((await runAsPrincipal(platform, () => loadGuardrails())).platform, true);
  assert.deepEqual((recordedPrisma.called("organization", "findMany")[0]?.args as { where: unknown }).where, {});
  assert.deepEqual((recordedPrisma.called("policyOverride", "findMany")[0]?.args as { where: unknown }).where, {});
});

test("the usage page hides markups in the company scope and tells the overview which scope it shows", async () => {
  const { loadUsage, loadUsageTabs } = await import("@/lib/usage/dashboard");
  assert.deepEqual(await runAsPrincipal(platform, () => loadUsageTabs()), ["overview", "markups"]);
  assert.deepEqual(await runAsPrincipal(companyView, () => loadUsageTabs()), ["overview"]);
  recordedPrisma.reset();
  assert.equal((await runAsPrincipal(companyView, () => loadUsage(7))).companyView, true);
  assert.equal((await runAsPrincipal(platform, () => loadUsage(7))).companyView, false);
});

test("the console scope names the company and lists companies only for the owner", async () => {
  const { consoleScopeOf } = await import("@/lib/auth/console-scope");
  const companies = [
    { id: COMPANY_ID, alias: "Acme" },
    { id: "orgglobex01", alias: "Globex" },
  ];
  recordedPrisma.reset({ organization: { findMany: () => companies } });
  assert.deepEqual(await consoleScopeOf(platform), { scope: { kind: "platform" }, companies, canSwitch: true });
  assert.deepEqual(await consoleScopeOf(companyView), {
    scope: { kind: "company", id: COMPANY_ID, alias: "Acme" },
    companies,
    canSwitch: true,
  });
  recordedPrisma.reset({ organization: { findUnique: () => ({ id: COMPANY_ID, alias: "Acme" }) } });
  assert.deepEqual(await consoleScopeOf(principal({ isOwner: false, orgId: COMPANY_ID })), {
    scope: { kind: "company", id: COMPANY_ID, alias: "Acme" },
    companies: [],
    canSwitch: false,
  });
  assert.equal(recordedPrisma.called("organization", "findMany").length, 0);
});

test("a scope change reaches this tab once and every other tab through the broadcast channel", async () => {
  const { notifyWorkspace, onWorkspaceChange, relayOtherTabs, WORKSPACE_CHANNEL } = await import("@/lib/auth/workspace-event");
  const target = globalThis as { window?: EventTarget };
  target.window = new EventTarget();
  const seen: WorkspaceChange[] = [];
  const received: unknown[] = [];
  const stopListening = onWorkspaceChange((change) => seen.push(change));
  const stopRelay = relayOtherTabs();
  const otherTab = new BroadcastChannel(WORKSPACE_CHANNEL);
  otherTab.onmessage = (event) => received.push(event.data);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  try {
    otherTab.postMessage({ orgId: COMPANY_ID, alias: "Acme" });
    otherTab.postMessage({ orgId: 42 });
    await settle();
    assert.deepEqual(seen, [{ orgId: COMPANY_ID, alias: "Acme" }]);

    notifyWorkspace({ orgId: null, alias: "" });
    await settle();
    assert.deepEqual(seen, [
      { orgId: COMPANY_ID, alias: "Acme" },
      { orgId: null, alias: "" },
    ]);
    assert.deepEqual(received, [{ orgId: null, alias: "" }]);
  } finally {
    stopListening();
    stopRelay();
    otherTab.close();
    delete target.window;
  }
});

test("the playground remembers the open session per tab and falls back when storage is blocked", async () => {
  const { rememberedSessionId, rememberSessionId } = await import("@/app/(app)/developer/_components/chat-session");
  const target = globalThis as { window?: unknown };
  const values = new Map<string, string>();
  target.window = {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  };
  try {
    assert.equal(rememberedSessionId(), null);
    assert.equal(rememberSessionId("session-2"), true);
    assert.equal(rememberedSessionId(), "session-2");
    target.window = {
      sessionStorage: {
        getItem: () => {
          throw new Error("blocked");
        },
        setItem: () => {
          throw new Error("blocked");
        },
      },
    };
    assert.equal(rememberedSessionId(), null);
    assert.equal(rememberSessionId("session-3"), false);
  } finally {
    delete target.window;
  }
});

test("the console layout keys only the page by scope so page state starts fresh after a switch", () => {
  const layout = readJsx(path.join(root, "src/app/(app)/layout.tsx"));
  const scoped = importedAs(layout, "./_components/console-scope", "ScopedPage");
  const within = (element: JsxNode): JsxNode[] => [element, ...element.children.flatMap(within)];
  const main = layout.elements.find((element) => element.tag === "main");
  assert.ok(main);
  assert.equal(layout.elements.filter((element) => element.tag === scoped).length, 1);
  assert.ok(within(main).some((element) => element.tag === scoped));
  assert.equal(within(main).some((element) => element.tag === "Sidebar" || element.tag === "ConsoleTopbar"), false);
});
