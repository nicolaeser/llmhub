import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { canOpen, canSee, homePath, NAV, navItemFor, platformOnlyPath, visibleNav } from "@/app/(app)/_components/nav-data";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { WORKSPACE_COOKIE } from "@/lib/auth/workspace-cookie";
import { permissions, PERMISSIONS } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";
import type { ScopeKind } from "@/types/console";

const root = fileURLToPath(new URL("../..", import.meta.url));
const COMPANY_ID = "orgacme0001";

function sessionRow(granted: Permission[], options: { isOwner?: boolean; orgId?: string | null } = {}) {
  return {
    id: "s1",
    expiresAt: new Date(Date.now() + 3_600_000),
    lastActive: new Date(),
    secondFactor: "TOTP",
    ipAddress: null,
    userAgent: null,
    user: {
      id: "u1",
      username: "member",
      blocked: false,
      isOwner: options.isOwner ?? false,
      orgId: options.orgId ?? null,
      roleId: "r1",
      role: { id: "r1", templateKey: null, name: "Custom", permissions: granted },
    },
  };
}

async function signedIn(cookies: Record<string, string> = {}) {
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("a".repeat(64)), ...cookies } });
}

async function redirectOf(render: () => Promise<unknown>): Promise<string | null> {
  const thrown = await render().then(
    () => null,
    (err: unknown) => err,
  );
  if (thrown === null) return null;
  const digest = String((thrown as { digest?: unknown } | null)?.digest ?? "");
  assert.match(digest, /^NEXT_REDIRECT;/);
  return digest.split(";")[2] ?? "";
}

function messages(locale: string) {
  return JSON.parse(readFileSync(path.join(root, "lang", locale, "Sidebar.json"), "utf8"));
}

function lookup(tree: Record<string, unknown>, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], tree);
}

function hrefs(scope: ScopeKind, granted: readonly Permission[] = permissions) {
  return visibleNav(granted, scope).flatMap((section) => section.items.map((item) => item.href));
}

test("the console lands on the first NAV item the user may open", () => {
  assert.equal(homePath(permissions), "/companies");
  assert.equal(homePath([PERMISSIONS.KEYS_READ]), "/keys");
  assert.equal(homePath([PERMISSIONS.SPEND_READ]), "/usage");
  assert.equal(homePath([PERMISSIONS.PLAYGROUND_USE]), "/developer");
  assert.equal(homePath([PERMISSIONS.ROLES_MANAGE]), "/users");
  assert.equal(homePath([PERMISSIONS.PRICING_READ]), "/usage");
  assert.equal(homePath([]), "/account");
});

test("the company scope lands on the first company page and never on a platform page", () => {
  assert.equal(homePath(permissions, "company"), "/companies");
  assert.equal(homePath([PERMISSIONS.PROVIDERS_READ, PERMISSIONS.SPEND_READ]), "/providers");
  assert.equal(homePath([PERMISSIONS.PROVIDERS_READ, PERMISSIONS.SPEND_READ], "company"), "/usage");
  assert.equal(homePath([PERMISSIONS.ROLES_MANAGE], "company"), "/account");
  assert.equal(homePath([PERMISSIONS.SETTINGS_READ], "company"), "/guardrails");
});

test("platform and company scopes show their own navigation", () => {
  assert.deepEqual(hrefs("platform"), [
    "/companies",
    "/users",
    "/providers",
    "/models",
    "/keys",
    "/guardrails",
    "/knowledge",
    "/mcp",
    "/usage",
    "/logs",
    "/settings",
    "/developer",
  ]);
  assert.deepEqual(hrefs("company"), [
    "/companies",
    "/keys",
    "/guardrails",
    "/knowledge",
    "/mcp",
    "/usage",
    "/logs",
    "/developer",
  ]);
  const platformSections = visibleNav(permissions, "platform").map((section) => section.id);
  const companySections = visibleNav(permissions, "company").map((section) => section.id);
  assert.deepEqual(platformSections, ["tenants", "gateway", "policies", "insights", "system"]);
  assert.deepEqual(companySections, ["organization", "policies", "insights", "system"]);
  const pinned = (scope: ScopeKind) =>
    visibleNav(permissions, scope)
      .filter((section) => section.pinned)
      .flatMap((section) => section.items.map((item) => item.href));
  assert.deepEqual(pinned("platform"), ["/settings", "/developer"]);
  assert.deepEqual(pinned("company"), ["/developer"]);
  assert.equal(navItemFor("/companies", "platform")?.labelKey, "items.companies");
  assert.equal(navItemFor("/companies/x", "company")?.labelKey, "items.company");
  assert.equal(navItemFor("/settings", "company"), undefined);
});

test("canSee checks the scope before the permission", () => {
  const items = NAV.flatMap((section) => section.items);
  const providers = items.find((item) => item.href === "/providers")!;
  const company = items.find((item) => item.href === "/companies" && item.scope === "company")!;
  const usage = items.find((item) => item.href === "/usage")!;
  assert.equal(canSee(permissions, providers), true);
  assert.equal(canSee(permissions, providers, "company"), false);
  assert.equal(canSee(permissions, company, "platform"), false);
  assert.equal(canSee(permissions, company, "company"), true);
  assert.equal(canSee(permissions, usage, "company"), true);
  assert.equal(canSee([], usage, "company"), false);
});

test("a page opens exactly when its navigation entry is visible", () => {
  assert.equal(canOpen([PERMISSIONS.USERS_READ], "/users", "platform"), true);
  assert.equal(canOpen([PERMISSIONS.ROLES_MANAGE], "/users", "platform"), true);
  assert.equal(canOpen([PERMISSIONS.USERS_MANAGE, PERMISSIONS.USERS_SECURITY], "/users", "platform"), false);
  assert.equal(canOpen(permissions, "/users", "company"), false);
  assert.equal(canOpen([PERMISSIONS.TENANCY_READ], "/companies/x", "company"), true);
  assert.equal(canOpen(permissions, "/account", "platform"), false);
  for (const scope of ["platform", "company"] as const) {
    for (const granted of [[], [PERMISSIONS.KEYS_READ], [PERMISSIONS.SPEND_READ], [...permissions]]) {
      for (const href of hrefs(scope, granted)) assert.equal(canOpen(granted, href, scope), true, `${scope} ${href}`);
    }
  }
});

test("the console users page sends callers without users:read or roles:manage back to the console home", async () => {
  const { default: UsersLayout } = await import("@/app/(app)/users/layout");
  for (const [granted, opens] of [
    [[], false],
    [[PERMISSIONS.KEYS_READ, PERMISSIONS.USERS_MANAGE], false],
    [[PERMISSIONS.USERS_READ], true],
    [[PERMISSIONS.ROLES_MANAGE], true],
  ] as const) {
    await signedIn();
    recordedPrisma.reset({ session: { findUnique: () => sessionRow([...granted]) } });
    const render = () => UsersLayout({ children: "page" });
    if (opens) assert.equal(await render(), "page", granted.join(","));
    else assert.equal(await redirectOf(render), "/", granted.join(","));
  }
});

test("platform-only paths are exactly the pages without a company entry", () => {
  for (const href of ["/settings", "/users", "/providers", "/models", "/providers/health", "/settings/x"]) {
    assert.equal(platformOnlyPath(href), true, href);
  }
  for (const href of ["/companies", "/keys", "/guardrails", "/knowledge", "/mcp", "/usage", "/logs", "/developer", "/account", "/modelsx"]) {
    assert.equal(platformOnlyPath(href), false, href);
  }
  const companyHrefs = new Set(hrefs("company"));
  for (const href of hrefs("platform")) assert.equal(platformOnlyPath(href), !companyHrefs.has(href), href);
});

test("the root path sends signed-in users to their console home and others to sign-in", async () => {
  const { default: ConsoleHome } = await import("@/app/(app)/page");
  setRequest();
  recordedPrisma.reset();
  assert.equal(await redirectOf(ConsoleHome), "/account/login");
  assert.deepEqual(recordedPrisma.calls, []);
  await signedIn();
  for (const [granted, home] of [
    [[PERMISSIONS.KEYS_READ], "/keys"],
    [[PERMISSIONS.SPEND_READ], "/usage"],
    [[], "/account"],
  ] as const) {
    recordedPrisma.handlers = { session: { findUnique: () => sessionRow([...granted]) } };
    assert.equal(await redirectOf(ConsoleHome), home);
  }
});

test("the root path sends the owner in a company view and company users to the company home", async () => {
  const { default: ConsoleHome } = await import("@/app/(app)/page");
  await signedIn({ [WORKSPACE_COOKIE]: COMPANY_ID });
  recordedPrisma.reset({
    session: { findUnique: () => sessionRow([], { isOwner: true }) },
    organization: { findUnique: () => ({ id: COMPANY_ID }) },
  });
  assert.equal(await redirectOf(ConsoleHome), "/companies");
  await signedIn();
  recordedPrisma.reset({
    session: { findUnique: () => sessionRow([PERMISSIONS.PROVIDERS_READ, PERMISSIONS.SPEND_READ], { orgId: COMPANY_ID }) },
  });
  assert.equal(await redirectOf(ConsoleHome), "/usage");
});

test("platform-only pages send the company scope back to the console home", async () => {
  const layouts = [
    { route: "settings", render: (await import("@/app/(app)/settings/layout")).default },
    { route: "users", render: (await import("@/app/(app)/users/layout")).default },
    { route: "models", render: (await import("@/app/(app)/models/layout")).default },
    { route: "providers", render: (await import("@/app/(app)/providers/layout")).default },
  ];
  for (const { route, render } of layouts) {
    await signedIn({ [WORKSPACE_COOKIE]: COMPANY_ID });
    recordedPrisma.reset({
      session: { findUnique: () => sessionRow([], { isOwner: true }) },
      organization: { findUnique: () => ({ id: COMPANY_ID }) },
    });
    assert.equal(await redirectOf(() => render({ children: "page" })), "/", route);

    await signedIn();
    recordedPrisma.reset({ session: { findUnique: () => sessionRow([PERMISSIONS.KEYS_READ], { orgId: COMPANY_ID }) } });
    assert.equal(await redirectOf(() => render({ children: "page" })), "/", route);

    await signedIn({ [WORKSPACE_COOKIE]: COMPANY_ID });
    recordedPrisma.reset({
      session: { findUnique: () => sessionRow([], { isOwner: true }) },
      organization: { findUnique: () => null },
    });
    assert.equal(await render({ children: "page" }), "page", route);
  }
});

test("retired console paths redirect to the tab that replaced them", async () => {
  const { default: config } = await import("../../next.config");
  const redirects = (await config.redirects?.()) ?? [];
  const target = new Map(redirects.map((rule) => [rule.source, rule.destination]));
  for (const source of ["/budgets", "/organizations", "/projects", "/structure", "/teams"]) {
    assert.equal(target.get(source), "/companies", source);
  }
  assert.equal(target.get("/subscriptions"), "/providers?tab=subscriptions");
  assert.equal(target.get("/provider-health"), "/providers?tab=health");
  assert.equal(target.get("/model-catalog"), "/models");
  assert.equal(target.get("/model-templates"), "/keys?tab=templates");
  assert.equal(target.get("/roles"), "/users?tab=roles");
  assert.equal(target.get("/markups"), "/usage?tab=markups");
  assert.equal(target.get("/logging"), "/settings?tab=logging");
  assert.equal(target.get("/playground"), "/developer?tab=playground");
  assert.equal(target.get("/api-ref"), "/developer?tab=api");
  assert.equal(target.get("/integrations"), "/mcp");
  for (const rule of redirects) {
    assert.equal(rule.permanent, false, rule.source);
    assert.equal(existsSync(path.join(root, "src/app/(app)", rule.source, "page.tsx")), false, rule.source);
  }
  assert.equal(redirects.some((rule) => rule.source === "/"), false);
});

test("the sidebar brand links to the scope-aware console home", () => {
  const sidebar = readFileSync(path.join(root, "src/app/(app)/_components/sidebar.tsx"), "utf8");
  assert.match(sidebar, /href=\{homePath\(permissions, kind\)\}/);
});

test("every NAV entry has a page and labels in both locales", () => {
  for (const scope of ["platform", "company"] as const) {
    const list = NAV.flatMap((section) => section.items.filter((item) => item.scope === scope || item.scope === "both"));
    const scoped = list.map((item) => item.href);
    assert.equal(new Set(scoped).size, scoped.length, scope);
  }
  for (const item of NAV.flatMap((section) => section.items)) {
    assert.equal(existsSync(path.join(root, "src/app/(app)", item.href, "page.tsx")), true, item.href);
  }
  for (const locale of ["en", "de"]) {
    const tree = messages(locale);
    for (const section of NAV) {
      assert.equal(typeof lookup(tree, section.labelKey), "string", `${locale} ${section.labelKey}`);
      for (const item of section.items) {
        assert.equal(typeof lookup(tree, item.labelKey), "string", `${locale} ${item.labelKey}`);
      }
    }
    const sectionLabels = NAV.map((section) => lookup(tree, section.labelKey));
    const itemLabels = NAV.flatMap((section) => section.items.map((item) => lookup(tree, item.labelKey)));
    for (const label of itemLabels) assert.equal(sectionLabels.includes(label), false, `${locale} ${label}`);
  }
});

test("the console keeps a short navigation in each scope", () => {
  for (const scope of ["platform", "company"] as const) {
    assert.ok(hrefs(scope).length <= 13, scope);
  }
  for (const section of NAV) assert.ok(section.items.length >= 2, section.id);
});

test("console copy no longer calls a scope a workspace", () => {
  for (const locale of ["en", "de"]) {
    const text = readFileSync(path.join(root, "lang", locale, "Sidebar.json"), "utf8");
    assert.doesNotMatch(text, /workspace|arbeitsbereich/i, locale);
  }
});
