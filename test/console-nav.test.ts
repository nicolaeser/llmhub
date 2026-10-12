import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { homePath, NAV } from "@/app/(app)/_components/nav-data";
import { permissions, PERMISSIONS } from "@/lib/auth/permissions";

const root = fileURLToPath(new URL("..", import.meta.url));

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

test("the root path resolves through the permission-aware console home", () => {
  const page = readFileSync(path.join(root, "src/app/(app)/page.tsx"), "utf8");
  assert.match(page, /requireAuth\(\)/);
  assert.match(page, /redirect\(homePath\(session\.permissions\)\)/);
  const config = readFileSync(path.join(root, "next.config.ts"), "utf8");
  assert.doesNotMatch(config, /source: "\/"/);
  assert.doesNotMatch(config, /"\/keys"/);
  for (const retired of ["/structure", "/organizations", "/teams", "/projects", "/budgets"]) {
    assert.match(config, new RegExp(`"${retired}"`));
  }
  assert.match(config, /destination: "\/companies"/);
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
