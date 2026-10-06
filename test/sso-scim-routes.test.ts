import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function src(rel: string) {
  return path.join(root, "src", rel);
}

test("SSO login and callback routes live under /sso and set a session cookie on callback", async () => {
  const login = src("app/sso/login/route.ts");
  const callback = src("app/sso/callback/route.ts");
  assert.equal(existsSync(login), true);
  assert.equal(existsSync(callback), true);
  const loginSrc = await readFile(login, "utf8");
  const callbackSrc = await readFile(callback, "utf8");
  assert.match(loginSrc, /export async function GET/);
  assert.match(loginSrc, /buildAuthorizationUrl/);
  assert.match(callbackSrc, /createSession/);
  assert.match(callbackSrc, /sessionCookieOptions/);
  assert.match(callbackSrc, /exchangeOidcCode/);
  assert.doesNotMatch(callbackSrc, /writeJSON/);
});

test("SCIM Users routes use the dedicated SCIM token and scim+json", async () => {
  const collection = src("app/scim/v2/Users/route.ts");
  const item = src("app/scim/v2/Users/[id]/route.ts");
  assert.equal(existsSync(collection), true);
  assert.equal(existsSync(item), true);
  const colSrc = await readFile(collection, "utf8");
  const itemSrc = await readFile(item, "utf8");
  assert.match(colSrc, /export async function GET/);
  assert.match(colSrc, /export async function POST/);
  assert.match(colSrc, /requireScimToken/);
  assert.match(itemSrc, /requireScimToken/);
  assert.match(itemSrc, /export async function DELETE/);
  const helper = await readFile(src("lib/gateway/scim.ts"), "utf8");
  assert.match(helper, /application\/scim\+json/);
  assert.match(helper, /scim_token_hash/);
  assert.doesNotMatch(helper, /authenticateBearer/);
});

function routeHandlers(source: string) {
  return source
    .split(/(?=export async function )/)
    .filter((chunk) => chunk.startsWith("export async function "))
    .map((chunk) => ({ name: chunk.match(/^export async function (\w+)/)?.[1] ?? "", body: chunk }));
}

test("SCIM user item route exports GET, PUT, PATCH, DELETE and every handler checks the SCIM token", async () => {
  const handlers = routeHandlers(await readFile(src("app/scim/v2/Users/[id]/route.ts"), "utf8"));
  assert.deepEqual(handlers.map((handler) => handler.name).sort(), ["DELETE", "GET", "PATCH", "PUT"]);
  for (const handler of handlers) {
    assert.match(handler.body, /await requireScimToken\(req\)/, handler.name);
  }
  const byName = new Map(handlers.map((handler) => [handler.name, handler.body]));
  assert.match(byName.get("PUT") ?? "", /parseScimPut/);
  assert.match(byName.get("PATCH") ?? "", /parseScimPatch/);
  assert.match(byName.get("PUT") ?? "", /updateScimUser/);
  assert.match(byName.get("PATCH") ?? "", /updateScimUser/);
});

test("SCIM collection handlers all check the SCIM token", async () => {
  const handlers = routeHandlers(await readFile(src("app/scim/v2/Users/route.ts"), "utf8"));
  assert.deepEqual(handlers.map((handler) => handler.name).sort(), ["GET", "POST"]);
  for (const handler of handlers) {
    assert.match(handler.body, /await requireScimToken\(req\)/, handler.name);
  }
});

test("SCIM refuses to update or delete the owner account", async () => {
  const helper = await readFile(src("lib/gateway/scim.ts"), "utf8");
  const update = helper.slice(helper.indexOf("export async function updateScimUser"));
  const remove = helper.slice(helper.indexOf("export async function deleteScimUser"));
  assert.match(update, /if \(user\.isOwner\) throw scimFailure\(403,/);
  assert.match(remove, /if \(user\.isOwner\) throw scimFailure\(403,/);
  assert.match(update, /action: "scim\.user\.update"/);
  assert.doesNotMatch(helper, /proxy_admin/);
});

test("SCIM token management requires every permission and a step-up", async () => {
  const action = await readFile(src("app/(app)/admin-settings/_action.ts"), "utf8");
  assert.match(action, /assertCanGrant\(grantActor\(session\), permissions\)/);
  assert.match(action, /requireStepUp/);
  assert.match(action, /PERMISSIONS\.SETTINGS_MANAGE/);
});

test("there is no master key", async () => {
  for (const file of [
    "lib/gateway/principal.ts",
    "lib/bootstrap/system-catalog.ts",
    "app/(app)/admin-settings/_action.ts",
  ]) {
    assert.doesNotMatch(await readFile(src(file), "utf8"), /master/i);
  }
});

test("admin settings validate and save sso without jwt or custom auth", async () => {
  const [action, schema] = await Promise.all([
    readFile(src("app/(app)/admin-settings/_action.ts"), "utf8"),
    readFile(src("schemas/settings.ts"), "utf8"),
  ]);
  assert.match(action, /adminSettingsSchema\.safeParse/);
  assert.match(schema, /oidc: z\.object/);
  assert.doesNotMatch(schema, /jwt: z\.object/);
  assert.doesNotMatch(schema, /custom_auth_url/);
  assert.doesNotMatch(action, /enterprise,\n/);
});

test("login password step offers SSO when enabled", async () => {
  const form = await readFile(
    src("app/account/login/_components/password-step.tsx"),
    "utf8",
  );
  assert.match(form, /ssoEnabled/);
  assert.match(form, /\/sso\/login/);
  assert.match(form, /useTranslations/);
});
