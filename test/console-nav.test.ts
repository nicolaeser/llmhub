import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { homePath, NAV } from "@/app/(app)/_components/nav-data";
import { SESSION_COOKIE, signSessionToken } from "@/lib/auth/cookie";
import { permissions, PERMISSIONS } from "@/lib/auth/permissions";
import type { Permission } from "@/types/auth";

const root = fileURLToPath(new URL("..", import.meta.url));

function sessionRow(granted: Permission[]) {
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
      isOwner: false,
      orgId: null,
      roleId: "r1",
      role: { id: "r1", templateKey: null, name: "Custom", permissions: granted },
    },
  };
}

async function redirectOf(render: () => Promise<unknown>): Promise<string> {
  const thrown = await render().then(
    () => null,
    (err: unknown) => err,
  );
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

test("the console lands on the first NAV item the user may open", () => {
  assert.equal(homePath(permissions), "/companies");
  assert.equal(homePath([PERMISSIONS.KEYS_READ]), "/keys");
  assert.equal(homePath([PERMISSIONS.SPEND_READ]), "/usage");
  assert.equal(homePath([PERMISSIONS.PLAYGROUND_USE]), "/playground");
  assert.equal(homePath([]), "/account");
});

test("the root path sends signed-in users to their console home and others to sign-in", async () => {
  const { default: ConsoleHome } = await import("@/app/(app)/page");
  setRequest();
  recordedPrisma.reset();
  assert.equal(await redirectOf(ConsoleHome), "/account/login");
  assert.deepEqual(recordedPrisma.calls, []);
  setRequest({ cookies: { [SESSION_COOKIE]: await signSessionToken("a".repeat(64)) } });
  for (const [granted, home] of [
    [[PERMISSIONS.KEYS_READ], "/keys"],
    [[PERMISSIONS.SPEND_READ], "/usage"],
    [[], "/account"],
  ] as const) {
    recordedPrisma.handlers = { session: { findUnique: () => sessionRow([...granted]) } };
    assert.equal(await redirectOf(ConsoleHome), home);
  }
});

test("retired structure paths redirect to companies and the console root is left to the home page", async () => {
  const { default: config } = await import("../next.config");
  const redirects = (await config.redirects?.()) ?? [];
  assert.deepEqual(
    redirects.map((rule) => rule.source).sort(),
    ["/budgets", "/organizations", "/projects", "/structure", "/teams"],
  );
  for (const rule of redirects) {
    assert.equal(rule.destination, "/companies", rule.source);
    assert.equal(rule.permanent, false, rule.source);
  }
});

test("the sidebar brand links to the permission-aware console home", () => {
  const sidebar = readFileSync(path.join(root, "src/app/(app)/_components/sidebar.tsx"), "utf8");
  assert.match(sidebar, /href=\{homePath\(permissions\)\}/);
});

test("every NAV entry has a page and labels in both locales", () => {
  const hrefs = NAV.flatMap((section) => section.items.map((item) => item.href));
  assert.equal(new Set(hrefs).size, hrefs.length);
  for (const href of hrefs) {
    assert.equal(existsSync(path.join(root, "src/app/(app)", href, "page.tsx")), true, href);
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

test("related console pages sit together in NAV", () => {
  const sectionOf = (href: string) => NAV.find((section) => section.items.some((item) => item.href === href))?.id;
  assert.equal(sectionOf("/subscriptions"), sectionOf("/providers"));
  assert.equal(sectionOf("/provider-health"), sectionOf("/providers"));
  assert.equal(sectionOf("/logging"), sectionOf("/admin-settings"));
  const models = NAV.find((section) => section.id === sectionOf("/providers"))!.items.map((item) => item.href);
  assert.equal(models.indexOf("/subscriptions"), models.indexOf("/providers") + 1);
});
