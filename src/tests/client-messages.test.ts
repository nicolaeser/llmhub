import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { navItemFor } from "@/app/(app)/_components/nav-data";
import { CLIENT_NAMESPACES, pickMessages, type ClientMessageArea } from "@/i18n/client-messages";
import { messageAt } from "@/i18n/message-tree";
import { loadLocaleMessages } from "@/i18n/messages";
import { importedAs, readJsx } from "./support/jsx-source";
import { clientTranslationUses, isCoveredBy, routeUiFiles } from "./support/client-translations";

const srcRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = path.join(srcRoot, "app");
const AREAS = Object.keys(CLIENT_NAMESPACES) as ClientMessageArea[];
const PUBLIC_AREAS: ClientMessageArea[] = ["root", "account", "providers/sub-add", "internal-api/setup"];
const SHARED_PROVIDER_COPY = ["Providers.kindShort", "Providers.pool", "Providers.poolHint", "Providers.signIn"];
const SHARED_ROLE_COPY = ["Roles.noRole", "Roles.permissions", "Roles.templateName"];
const CONSOLE_ONLY = [
  "Account",
  "ApiRef",
  "Budgets",
  "Common.health",
  "Common.live",
  "Common.updater",
  "Common.version",
  "Companies",
  "Developer",
  "Guardrails",
  "Integrations",
  "Keys",
  "Knowledge",
  "Logs",
  "Markdown",
  "Markups",
  "Mcp",
  "ModelCatalog",
  "ModelTemplates",
  "Models",
  "Playground",
  "ProviderHealth",
  "Providers",
  "Roles",
  "Settings",
  "Sidebar",
  "Subscriptions",
  "Usage",
  "Users",
];
const PLATFORM_ONLY = [
  "ModelCatalog",
  "ModelTemplates",
  "Models",
  "ProviderHealth",
  "Providers",
  "Roles",
  "Settings",
  "Subscriptions",
  "Users",
];
const COMPANY_SHARED_COPY = [...SHARED_PROVIDER_COPY, ...SHARED_ROLE_COPY, "ModelTemplates.matchCount"];

function areaDir(area: ClientMessageArea): string {
  return area === "root" ? appRoot : path.join(appRoot, area);
}

function parentAreas(area: ClientMessageArea): ClientMessageArea[] {
  if (area === "root") return [];
  return AREAS.filter((other) => other === "root" || (other !== area && area.startsWith(`${other}/`)));
}

function ownRouteFiles(area: ClientMessageArea): string[] {
  const nested = AREAS.filter((other) => parentAreas(other).includes(area)).map(areaDir);
  return routeUiFiles(areaDir(area), { recursive: true }).filter(
    (file) => !nested.some((dir) => file.startsWith(`${dir}${path.sep}`)),
  );
}

function deliveredTo(area: ClientMessageArea): string[] {
  return [...parentAreas(area), area].flatMap((each) => [...CLIENT_NAMESPACES[each]]);
}

function overlaps(a: string, b: string): boolean {
  return isCoveredBy(a, [b]) || isCoveredBy(b, [a]);
}

function leaks(entry: string, restricted: readonly string[], shared: readonly string[]): string | undefined {
  if (isCoveredBy(entry, shared)) return undefined;
  return restricted.find((namespace) => overlaps(entry, namespace));
}

function opensInCompanyScope(area: ClientMessageArea): boolean {
  if (area === "(app)" || area === "(app)/account") return true;
  return area.startsWith("(app)/") && navItemFor(`/${area.slice("(app)/".length)}`, "company") !== undefined;
}

test("pickMessages copies the listed namespaces and messages without touching the catalog", () => {
  const catalog = {
    Common: { save: "Save", cancel: "Cancel", updater: { title: "Updater" } },
    Error: { code: "{code}", boundary: { title: "Oops" } },
    Settings: { title: "Settings" },
  };
  const before = structuredClone(catalog);
  const picked = pickMessages(catalog, ["Common.save", "Common.cancel", "Error.boundary", "Missing.key", "Common.__proto__"]);
  assert.deepEqual(picked, { Common: { save: "Save", cancel: "Cancel" }, Error: { boundary: { title: "Oops" } } });
  assert.deepEqual(pickMessages(catalog, ["Settings"]), { Settings: { title: "Settings" } });
  assert.deepEqual(pickMessages(catalog, []), {});
  assert.deepEqual(catalog, before);
});

test("every client message area is a route directory whose layout hands over exactly its own area", () => {
  for (const area of AREAS) {
    if (area === "root") continue;
    const layoutFile = path.join(areaDir(area), "layout.tsx");
    assert.ok(existsSync(layoutFile), `${area} has no layout.tsx`);
    const layout = readJsx(layoutFile);
    const provider = layout.elements.filter((element) => element.tag === importedAs(layout, "@/components/i18n/area-messages"));
    assert.deepEqual(
      provider.map((element) => element.attributes.get("area")),
      [area],
      `${area}/layout.tsx must render <AreaMessages area="${area}">`,
    );
  }
});

test("every console section has its own client message area", () => {
  const consoleRoot = path.join(appRoot, "(app)");
  const sections = readdirSync(consoleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .filter((entry) => existsSync(path.join(consoleRoot, entry.name, "page.tsx")))
    .map((entry) => `(app)/${entry.name}`);
  assert.ok(sections.length > 10);
  assert.deepEqual(sections.filter((section) => !AREAS.includes(section as ClientMessageArea)), []);
});

test("the root layout hands the client only the root allowlist", () => {
  const layout = readJsx(path.join(appRoot, "layout.tsx"));
  const provider = layout.elements.filter((element) => element.tag === importedAs(layout, "next-intl", "NextIntlClientProvider"));
  assert.equal(provider.length, 1);
  assert.equal(provider[0]!.attributes.get("messages"), "messages");
  assert.equal(importedAs(layout, "next-intl/server", "getMessages"), null);
  assert.equal(importedAs(layout, "@/i18n/client-messages", "clientMessages"), "clientMessages");
  assert.deepEqual(CLIENT_NAMESPACES.root, []);
});

test("every namespace a client component translates is delivered to its area", () => {
  const missing: string[] = [];
  for (const area of AREAS) {
    const { uses, unresolved } = clientTranslationUses(srcRoot, ownRouteFiles(area));
    assert.deepEqual(unresolved, [], `${area}: useTranslations needs a literal namespace`);
    const delivered = deliveredTo(area);
    for (const use of uses) {
      if (!isCoveredBy(use.path, delivered)) missing.push(`${area}: ${use.path} (${path.relative(srcRoot, use.file)})`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});

test("every allowlist entry is used by a client component of its area and listed once", () => {
  for (const area of AREAS) {
    const { uses } = clientTranslationUses(srcRoot, ownRouteFiles(area));
    const inherited = parentAreas(area).flatMap((each) => [...CLIENT_NAMESPACES[each]]);
    const own: readonly string[] = CLIENT_NAMESPACES[area];
    for (const entry of own) {
      assert.ok(
        uses.some((use) => isCoveredBy(use.path, [entry])),
        `${area}: ${entry} is not translated by any client component there`,
      );
      const elsewhere = [...inherited, ...own.filter((other) => other !== entry)];
      assert.ok(!isCoveredBy(entry, elsewhere), `${area}: ${entry} is already delivered by another entry`);
    }
  }
});

test("every allowlist entry exists in the English and German catalogs", async () => {
  for (const locale of ["en", "de"]) {
    const catalog = await loadLocaleMessages(locale);
    for (const area of AREAS) {
      for (const entry of CLIENT_NAMESPACES[area]) {
        assert.notEqual(messageAt(catalog, entry), undefined, `${locale}: ${area} lists unknown ${entry}`);
      }
    }
  }
});

test("public pages never receive console copy", () => {
  for (const area of PUBLIC_AREAS) {
    for (const entry of deliveredTo(area)) {
      const owner = leaks(entry, CONSOLE_ONLY, SHARED_PROVIDER_COPY);
      assert.equal(owner, undefined, `${area} receives ${entry}, which belongs to the console (${owner})`);
    }
  }
});

test("console areas a company scope can open never receive platform-only copy", () => {
  const companyAreas = AREAS.filter(opensInCompanyScope);
  assert.ok(companyAreas.includes("(app)/keys"));
  assert.ok(!companyAreas.includes("(app)/settings"));
  for (const area of companyAreas) {
    for (const entry of deliveredTo(area)) {
      const owner = leaks(entry, PLATFORM_ONLY, COMPANY_SHARED_COPY);
      assert.equal(owner, undefined, `${area} receives ${entry}, which only platform pages use (${owner})`);
    }
  }
});
