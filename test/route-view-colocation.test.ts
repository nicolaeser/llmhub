import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  importersOf,
  isAllowedAppTsx,
  isForbiddenAppViewFile,
  isForbiddenAppViewTsx,
  isRouteColocatedView,
  isWholePageExtractName,
  listForbiddenAppViewFiles,
  listSourceFiles,
  listWholePageExtractFiles,
  moduleSpecifiers,
  routeKey,
} from "./route-view-policy";

const root = fileURLToPath(new URL("..", import.meta.url));
const srcRoot = path.join(root, "src");
const appRoot = path.join(srcRoot, "app");
const componentsRoot = path.join(srcRoot, "components");
const read = (file: string) => readFileSync(file, "utf8");

function walkFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

test("allows Next special files and route actions only", () => {
  assert.equal(isForbiddenAppViewTsx("page.tsx"), false);
  assert.equal(isForbiddenAppViewTsx("layout.tsx"), false);
  assert.equal(isForbiddenAppViewTsx("_action.tsx"), false);
  assert.equal(isForbiddenAppViewTsx("_actions.tsx"), false);
  assert.equal(isAllowedAppTsx("_action.ts"), true);
  assert.equal(isAllowedAppTsx("_actions.ts"), true);
  assert.equal(isAllowedAppTsx("icon.tsx"), true);
  assert.equal(isForbiddenAppViewTsx("Foo.tsx"), true);
  assert.equal(isForbiddenAppViewTsx("shared.tsx"), true);
  assert.equal(isForbiddenAppViewTsx("account-shell.tsx"), true);
});

test("walker allows _components and flags other view modules", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "route-view-policy-"));
  mkdirSync(path.join(tmp, "projects", "_components"), { recursive: true });
  writeFileSync(
    path.join(tmp, "page.tsx"),
    "export default function Page() {}",
  );
  writeFileSync(path.join(tmp, "_action.ts"), "export async function action() {}");
  writeFileSync(
    path.join(tmp, "_action.tsx"),
    "export async function action() {}",
  );
  writeFileSync(
    path.join(tmp, "projects", "_components", "projects-view.tsx"),
    "export function ProjectsView() { return null; }",
  );
  writeFileSync(
    path.join(tmp, "projects", "Extra.tsx"),
    "export function Extra() { return null; }",
  );
  const violations = listForbiddenAppViewFiles(tmp).map((file) =>
    path.relative(tmp, file),
  );
  assert.deepEqual(violations, [path.join("projects", "Extra.tsx")]);
  assert.equal(
    isRouteColocatedView(
      path.join(tmp, "projects", "_components", "projects-view.tsx"),
    ),
    true,
  );
  assert.equal(
    isForbiddenAppViewFile(
      path.join(tmp, "projects", "_components", "projects-view.tsx"),
    ),
    false,
  );
  assert.equal(isForbiddenAppViewFile(path.join(tmp, "_action.ts")), false);
});

test("src/app has no view modules outside Next special files and _components", () => {
  const violations = listForbiddenAppViewFiles(appRoot).map((file) =>
    path.relative(root, file),
  );
  assert.deepEqual(violations, []);
});

test("colocated _components files use kebab-case names", () => {
  const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*\.(?:ts|tsx)$/;
  const files = walkFiles(appRoot).filter((file) =>
    file.split(path.sep).includes("_components"),
  );
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.match(path.basename(file), kebab);
  }
});

test("predicate flags whole-page extracts in _components", () => {
  assert.equal(isWholePageExtractName("keys-page.tsx"), true);
  assert.equal(isWholePageExtractName("setup-page.ts"), true);
  assert.equal(isWholePageExtractName("login-form.tsx"), false);
  assert.equal(isWholePageExtractName("account-shell.tsx"), false);
});

test("walker flags colocated *-page modules", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "route-view-page-"));
  mkdirSync(path.join(tmp, "projects", "_components"), { recursive: true });
  writeFileSync(
    path.join(tmp, "projects", "_components", "projects-page.tsx"),
    "export default function ProjectsPage() { return null; }",
  );
  writeFileSync(
    path.join(tmp, "projects", "_components", "project-form.tsx"),
    "export default function ProjectForm() { return null; }",
  );
  const extracts = listWholePageExtractFiles(tmp).map((file) =>
    path.relative(tmp, file),
  );
  assert.deepEqual(extracts, [
    path.join("projects", "_components", "projects-page.tsx"),
  ]);
});

test("src/app _components has no whole-page *-page modules", () => {
  const extracts = listWholePageExtractFiles(appRoot).map((file) =>
    path.relative(root, file),
  );
  assert.deepEqual(extracts, []);
});

test("console layout wraps Sidebar from colocated _components", () => {
  const layout = readFileSync(
    path.join(appRoot, "(app)", "layout.tsx"),
    "utf8",
  );
  assert.match(layout, /from "\.\/_components\/sidebar"/);
  assert.match(layout, /<Sidebar[\s>]/);
  assert.doesNotMatch(layout, /function Sidebar/);
});

test("pages import colocated views and keep auth/data/composition", () => {
  const login = readFileSync(
    path.join(appRoot, "account", "login", "page.tsx"),
    "utf8",
  );
  const register = readFileSync(
    path.join(appRoot, "account", "register", "page.tsx"),
    "utf8",
  );
  const forgot = readFileSync(
    path.join(appRoot, "account", "forgot-password", "page.tsx"),
    "utf8",
  );
  const reset = readFileSync(
    path.join(appRoot, "account", "reset-password", "page.tsx"),
    "utf8",
  );
  const setup = readFileSync(
    path.join(appRoot, "internal-api", "setup", "page.tsx"),
    "utf8",
  );
  const apiRef = readFileSync(
    path.join(appRoot, "(app)", "api-ref", "page.tsx"),
    "utf8",
  );
  const usage = readFileSync(
    path.join(appRoot, "(app)", "usage", "page.tsx"),
    "utf8",
  );

  assert.match(login, /"use client"/);
  assert.match(login, /from "\.\/_components\/password-step"/);
  assert.match(login, /loginContextAction/);
  assert.doesNotMatch(login, /Suspense|export \{ default \} from/);

  for (const page of [register, forgot, reset]) {
    assert.match(page, /"use client"/);
    assert.match(page, /AccountShell/);
    assert.doesNotMatch(page, /Suspense|export \{ default \} from/);
  }
  assert.match(reset, /useSearchParam\("token"\)/);

  assert.match(setup, /"use client"/);
  assert.match(setup, /createFirstAdminAction/);
  assert.doesNotMatch(setup, /export \{ default \} from/);

  assert.match(apiRef, /from "\.\/_components\/copy-button"/);
  assert.match(apiRef, /from "\.\/_components\/try-endpoint"/);
  assert.match(usage, /from "\.\/_components\/filter-select"/);
  assert.doesNotMatch(apiRef, /function CopyButton/);
  assert.doesNotMatch(usage, /function FilterSelect/);
});

test("pages do not stub an EntirePage from src/components", () => {
  const pages = walkFiles(appRoot).filter(
    (file) => path.basename(file) === "page.tsx",
  );
  assert.ok(pages.length > 0);
  for (const file of pages) {
    const source = readFileSync(file, "utf8");
    assert.doesNotMatch(source, /export \{ default \} from/);
    assert.doesNotMatch(
      source,
      /from ["']@\/components\/[^"']*(?:Page|page)["']/,
    );
  }
});

test("shared shells stay in app _components, not src/components", () => {
  assert.equal(
    existsSync(path.join(appRoot, "account", "_components", "account-shell.tsx")),
    true,
  );
  assert.equal(
    existsSync(path.join(appRoot, "(app)", "_components", "sidebar.tsx")),
    true,
  );
  const componentsRoot = path.join(root, "src", "components");
  for (const name of [
    "AccountShell.tsx",
    "Sidebar.tsx",
    "site/account/AccountShell.tsx",
    "Provider/AppProviders.tsx",
    "Provider/ThemeSwitcher.tsx",
    "provider/app-providers.tsx",
  ]) {
    assert.equal(existsSync(path.join(componentsRoot, name)), false, name);
  }
});

test("route-only views are not in src/components", () => {
  const componentsRoot = path.join(root, "src", "components");
  for (const name of [
    "login-form.tsx",
    "register-form.tsx",
    "setup-form.tsx",
    "copy-button.tsx",
    "filter-select.tsx",
    "try-endpoint.tsx",
  ]) {
    assert.equal(existsSync(path.join(componentsRoot, name)), false, name);
  }
});

test("does not keep a src/lib/route-view-policy twin", () => {
  assert.equal(existsSync(path.join(root, "src/lib/route-view-policy.ts")), false);
  assert.equal(existsSync(path.join(root, "src/lib/ui")), false);
  assert.equal(existsSync(path.join(root, "test/route-view-policy.ts")), true);
});

test("src/components domain folders are lowercase when present", () => {
  const componentsRoot = path.join(root, "src", "components");
  if (!existsSync(componentsRoot)) return;
  const dirs = readdirSync(componentsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  for (const name of dirs) {
    assert.equal(name, name.toLowerCase());
    assert.notEqual(name, "_components");
    assert.notEqual(name, "Provider");
  }
});

test("routeKey groups a route with its colocated _components", () => {
  assert.equal(routeKey(srcRoot, path.join(appRoot, "(app)", "users", "page.tsx")), "app/(app)/users");
  assert.equal(
    routeKey(srcRoot, path.join(appRoot, "(app)", "users", "_components", "user-dialogs.tsx")),
    "app/(app)/users",
  );
  assert.equal(routeKey(srcRoot, path.join(appRoot, "(app)", "_components", "sidebar.tsx")), "app/(app)");
  assert.equal(routeKey(srcRoot, path.join(componentsRoot, "console", "page-header.tsx")), "components");
});

test("moduleSpecifiers reads static, re-export, and dynamic imports", () => {
  assert.deepEqual(
    moduleSpecifiers(
      'import A from "@/a";\nimport { b } from "./b";\nexport { c } from "../c";\nconst d = await import("@/d");',
    ),
    ["@/a", "./b", "../c", "@/d"],
  );
});

test("src/components holds only UI shared by more than one route", () => {
  const importers = importersOf(srcRoot, read);
  const files = listSourceFiles(componentsRoot);
  assert.ok(files.length > 0);
  for (const file of files) {
    const owners = new Set(importers(file).map((importer) => routeKey(srcRoot, importer)));
    const shared = owners.has("components") || owners.size >= 2;
    assert.ok(
      shared,
      `${path.relative(root, file)} is used by ${[...owners].join(", ") || "nothing"}; move it into that route's _components/`,
    );
  }
});

test("root src/app/_components serves only the root layout", () => {
  const importers = importersOf(srcRoot, read);
  const dir = path.join(appRoot, "_components");
  for (const file of existsSync(dir) ? listSourceFiles(dir) : []) {
    for (const importer of importers(file)) {
      assert.equal(
        path.dirname(importer),
        appRoot,
        `${path.relative(root, file)} is imported by ${path.relative(root, importer)}; shared UI belongs in src/components/<domain>/`,
      );
    }
  }
});

test("route _components are not imported from another route", () => {
  const importers = importersOf(srcRoot, read);
  for (const file of listSourceFiles(appRoot).filter(isRouteColocatedView)) {
    const owner = routeKey(srcRoot, file);
    for (const importer of importers(file)) {
      const from = routeKey(srcRoot, importer);
      assert.ok(
        from === owner || from.startsWith(`${owner}/`),
        `${path.relative(root, importer)} imports ${path.relative(root, file)} across routes; move it to src/components/<domain>/`,
      );
    }
  }
});

test("no re-export twins in src/app or src/components", () => {
  for (const file of [...listSourceFiles(appRoot), ...listSourceFiles(componentsRoot)]) {
    const body = read(file)
      .replace(/^"use (client|server)";\s*/m, "")
      .trim();
    assert.ok(
      body === "" || !/^(?:export\s+(?:\*|\{[^}]*\}|type\s+\{[^}]*\})\s+from\s+["'][^"']+["'];?\s*)+$/.test(body),
      `${path.relative(root, file)} only re-exports another module`,
    );
  }
});

test("moved shared UI lives in src/components domain folders", () => {
  for (const rel of [
    "brand/brand-mark.tsx",
    "console/page-header.tsx",
    "console/empty-state.tsx",
    "console/stat-card.tsx",
    "console/confirm-dialog.tsx",
    "budget/budget-dialog.tsx",
  ]) {
    assert.equal(existsSync(path.join(componentsRoot, rel)), true, rel);
  }
  for (const name of [
    "brand-mark.tsx",
    "page-header.tsx",
    "empty-state.tsx",
    "stat-card.tsx",
    "confirm-dialog.tsx",
    "budget-dialog.tsx",
  ]) {
    assert.equal(existsSync(path.join(appRoot, "_components", name)), false, name);
  }
});
