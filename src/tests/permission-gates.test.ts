import { recordedPrisma } from "./support/recorded-prisma";
import { setRequest } from "./support/next-headers-stub";
import { redirectOf, sessionRow, signedIn } from "./support/console-session";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { homePath, NAV, navItemFor, visibleNav } from "@/app/(app)/_components/nav-data";
import { roleTemplates } from "@/lib/auth/permissions";
import { isActionFail } from "@/lib/http/action-result";
import type { Permission } from "@/types/auth";

const appRoot = fileURLToPath(new URL("../app", import.meta.url));
const consoleRoot = path.join(appRoot, "(app)");
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const REFUSED = new Set(["FORBIDDEN", "Forbidden", "PLATFORM_ONLY", "Unauthorized", "UNAUTHORIZED"]);

const SELF_SECTIONS: Record<string, string> = {
  account: "the signed-in person's own account and security",
};

const PUBLIC_ROUTES: Record<string, string> = {
  "internal-api/health": "liveness probe",
  "internal-api/ready": "readiness probe",
  "internal-api/version": "build version",
  "internal-api/account/expired": "clears a stale session cookie",
  "internal-api/account/logout": "ends the caller's own session",
  "internal-api/account/forgot-password": "password reset request with quota",
  "internal-api/account/register": "self-registration behind its setting and rate limit",
  "internal-api/account/reset-password": "consumes a reset token",
  "internal-api/mcp/oauth/client": "public OAuth client metadata document",
  "internal-api/mcp/oauth/callback": "OAuth callback; the MCP manager check runs before the code is used",
  "internal-api/updater": "accepts only requests signed with the updater key",
  "sso/login": "starts OpenID Connect sign-in",
  "sso/callback": "OpenID Connect callback bound to the signed state",
  "sso/backchannel-logout": "accepts only a logout token verified against the identity provider's keys",
};

const PUBLIC_ACTION_FILES: Record<string, string> = {
  "account/login/_action.ts": "the sign-in flow before a session exists",
  "account/forgot-password/_action.ts": "reports whether password reset is available",
  "account/register/_action.ts": "reports whether registration is available",
  "internal-api/setup/_action.ts": "first-run setup, refused once a user exists",
  "providers/sub-add/[token]/_action.ts": "add-account link, checked by its token",
  "providers/sub-add/manage/[token]/_action.ts": "add-account management link, checked by its token",
};

const SELF_ACTIONS: Record<string, Record<string, string>> = {
  "(app)/account/_action.ts": { "*": "the signed-in person's own account" },
  "(app)/_action.ts": {
    setLocaleAction: "the caller's own language",
    loadConsoleScopeAction: "the caller's own scope",
    loadConsoleAccessAction: "the caller's own permissions",
    loadUpdateStatusAction: "build status; details only with settings:read",
  },
  "(app)/developer/_action.ts": { loadDeveloperTabsAction: "the tabs the caller may open" },
  "(app)/users/_action.ts": { loadUserTabsAction: "the tabs the caller may open" },
  "(app)/usage/_action.ts": { loadUsageTabsAction: "the tabs the caller may open" },
};

const SESSION_ROUTES: Record<string, string> = {
  "internal-api/live": "streams only the events the caller's permissions allow (liveAccess)",
};

function walk(dir: string, name: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, name);
    return entry.name === name ? [full] : [];
  });
}

function routeKey(file: string): string {
  return path.relative(appRoot, path.dirname(file)).split(path.sep).join("/");
}

function routeParams(key: string) {
  const params: Record<string, string | string[]> = {};
  for (const segment of key.split("/")) {
    const match = /^\[(\.\.\.)?(.+)\]$/.exec(segment);
    if (match) params[match[2]] = match[1] ? ["x"] : "x";
  }
  return { params: Promise.resolve(params) };
}

function request(key: string, method: string) {
  const url = `http://localhost:3000/${key.replace(/\[(\.\.\.)?[^\]]+\]/g, "x")}`;
  return new NextRequest(url, {
    method,
    headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
  });
}

type Handler = (req: NextRequest, ctx: ReturnType<typeof routeParams>) => Promise<Response>;

async function routeHandlers() {
  const files = walk(appRoot, "route.ts").sort();
  const loaded = [];
  for (const file of files) {
    const key = routeKey(file);
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const methods = HTTP_METHODS.filter((method) => typeof mod[method] === "function");
    loaded.push({ key, methods, mod });
  }
  return loaded;
}

function touchedData(allowed: readonly string[]) {
  return recordedPrisma.calls.filter((call) => !allowed.includes(call.model)).map((call) => `${call.model}.${call.method}`);
}

test("every console section checks its navigation permission on the server", async () => {
  const sections = readdirSync(consoleRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .filter((entry) => existsSync(path.join(consoleRoot, entry.name, "page.tsx")))
    .map((entry) => entry.name);
  const navSections = new Set(NAV.flatMap((section) => section.items.map((item) => item.href.slice(1))));
  assert.deepEqual([...navSections].filter((href) => !sections.includes(href)), []);
  for (const section of sections) {
    if (SELF_SECTIONS[section]) continue;
    assert.ok(navSections.has(section), `${section} has no navigation entry`);
    const layoutFile = path.join(consoleRoot, section, "layout.tsx");
    assert.ok(existsSync(layoutFile), `${section} has no layout guard`);
    const { default: Layout } = (await import(pathToFileURL(layoutFile).href)) as {
      default: (props: { children: string }) => Promise<unknown>;
    };
    const item = navItemFor(`/${section}`, "platform") ?? navItemFor(`/${section}`, "company");
    assert.ok(item, section);
    const needed = Array.isArray(item.permission) ? item.permission : [item.permission];
    for (const [granted, opens] of [
      [[] as Permission[], false],
      [[needed[0]], item.scope !== "company"],
    ] as const) {
      await signedIn();
      recordedPrisma.reset({ session: { findUnique: () => sessionRow(granted) } });
      const render = () => Layout({ children: "page" });
      if (opens) assert.equal(await render(), "page", `${section} ${granted.join(",")}`);
      else assert.equal(await redirectOf(render), "/", `${section} without permissions`);
    }
  }
});

test("every route handler refuses callers without credentials before touching data", async () => {
  const routes = await routeHandlers();
  assert.ok(routes.length > 100);
  const unlisted = [...Object.keys(PUBLIC_ROUTES), ...Object.keys(SESSION_ROUTES)].filter(
    (key) => !routes.some((route) => route.key === key),
  );
  assert.deepEqual(unlisted, []);
  for (const route of routes) {
    if (PUBLIC_ROUTES[route.key]) continue;
    assert.ok(route.methods.length, `${route.key} exports no handler`);
    for (const method of route.methods) {
      setRequest();
      recordedPrisma.reset({});
      const res = await (route.mod[method] as Handler)(request(route.key, method), routeParams(route.key));
      assert.ok([401, 403].includes(res.status), `${method} /${route.key} answered ${res.status}`);
      assert.deepEqual(touchedData(["setting"]), [], `${method} /${route.key}`);
    }
  }
});

test("console routes refuse a signed-in person without permissions", async () => {
  const routes = (await routeHandlers()).filter(
    (route) => route.key.startsWith("internal-api/") && !PUBLIC_ROUTES[route.key] && !SESSION_ROUTES[route.key],
  );
  assert.ok(routes.length > 5);
  for (const route of routes) {
    for (const method of route.methods) {
      await signedIn();
      recordedPrisma.reset({ session: { findUnique: () => sessionRow([]) } });
      const res = await (route.mod[method] as Handler)(request(route.key, method), routeParams(route.key));
      assert.ok([401, 403].includes(res.status), `${method} /${route.key} answered ${res.status}`);
      assert.deepEqual(touchedData(["session"]), [], `${method} /${route.key}`);
    }
  }
});

async function serverActions() {
  const files = walk(appRoot, "_action.ts").sort();
  const loaded = [];
  for (const file of files) {
    const key = path.relative(appRoot, file).split(path.sep).join("/");
    const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    const actions = Object.entries(mod).filter((entry): entry is [string, (...args: unknown[]) => Promise<unknown>] =>
      typeof entry[1] === "function",
    );
    loaded.push({ key, actions });
  }
  return loaded;
}

async function refusalOf(action: (...args: unknown[]) => Promise<unknown>, granted: readonly Permission[]) {
  await signedIn();
  recordedPrisma.reset({ session: { findUnique: () => sessionRow(granted) } });
  const result = await action();
  return { result, touched: touchedData(["session"]) };
}

test("every server action refuses a signed-in person without permissions before touching data", async () => {
  const files = await serverActions();
  assert.ok(files.length >= 15);
  const unlisted = [...Object.keys(PUBLIC_ACTION_FILES), ...Object.keys(SELF_ACTIONS)].filter(
    (key) => !files.some((file) => file.key === key),
  );
  assert.deepEqual(unlisted, []);
  let checked = 0;
  const failures: string[] = [];
  for (const file of files) {
    if (PUBLIC_ACTION_FILES[file.key]) continue;
    const self = SELF_ACTIONS[file.key] ?? {};
    for (const [name, action] of file.actions) {
      if (self["*"] || self[name]) continue;
      const { result, touched } = await refusalOf(action, []);
      if (!isActionFail(result) || !REFUSED.has(result.error) || touched.length) {
        failures.push(`${file.key} ${name}: ${isActionFail(result) ? result.error : "no refusal"} ${touched.join(",")}`);
      }
      checked += 1;
    }
  }
  assert.deepEqual(failures, []);
  assert.ok(checked > 150, `${checked} actions checked`);
});

test("the viewer template is refused every console change it does not hold a permission for", async () => {
  const files = await serverActions();
  const viewer = roleTemplates.viewer;
  const changes = [
    ["(app)/settings/_action.ts", "saveSignInSettingsAction"],
    ["(app)/settings/_action.ts", "setAppRolesModeAction"],
    ["(app)/settings/_action.ts", "saveGeneralSettingsAction"],
    ["(app)/users/_action.ts", "createUserAction"],
    ["(app)/users/_action.ts", "createRoleAction"],
    ["(app)/users/_action.ts", "deleteUserAction"],
    ["(app)/users/_action.ts", "restoreUserCredentialsAction"],
    ["(app)/providers/_action.ts", "createProviderAction"],
    ["(app)/models/_action.ts", "createModelGroupAction"],
    ["(app)/keys/_action.ts", "createKeyAction"],
    ["(app)/guardrails/_action.ts", "saveGuardrailPolicyAction"],
    ["(app)/companies/_action.ts", "saveOrgAction"],
    ["(app)/mcp/_action.ts", "createMcpServerAction"],
  ] as const;
  for (const [key, name] of changes) {
    const action = files.find((file) => file.key === key)?.actions.find(([exported]) => exported === name)?.[1];
    assert.ok(action, `${key} ${name} is missing`);
    const { result, touched } = await refusalOf(action, viewer);
    assert.ok(isActionFail(result) && REFUSED.has(result.error), `${key} ${name}`);
    assert.deepEqual(touched, [], `${key} ${name}`);
  }
});

test("a person without a role sees no navigation and lands on their own account page", () => {
  for (const scope of ["platform", "company"] as const) {
    assert.deepEqual(visibleNav([], scope), []);
    assert.equal(homePath([], scope), "/account");
  }
});
