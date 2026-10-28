import "./support/request-scope";
import "./support/smtp-capture";
import "./support/oidc-env";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { SESSION_COOKIE } from "@/lib/auth/cookie";
import { templateRoleId } from "@/lib/auth/roles";
import { getSession } from "@/lib/auth/session";
import { passwordSignIn, verifyLoginSecondFactor } from "@/lib/auth/sign-in";
import { signInWithSso, SsoError } from "@/lib/auth/sso-user";
import { deleteUser, setEmergencyAccess, setUserBlocked } from "@/lib/auth/users";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { normalizeOidc, patchEnterprise } from "@/lib/settings/enterprise";
import { closeDatabase, uniqueName } from "./support/database";
import { documentationAddress, enrollTotp, givePassword, totpCode } from "./support/factors";
import { preserveSetting, sessionOf, TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";
import { withDeferredWork } from "./support/request-scope";
import { capturedMail } from "./support/smtp-capture";

const ISSUER = "https://id.example.test";
const WEBHOOK_URL = "https://hooks.example.test/emergency";
let restoreEnterprise: () => Promise<void>;

before(async () => {
  restoreEnterprise = await preserveSetting("enterprise");
  await ensureSystemCatalog();
});

after(async () => {
  await restoreEnterprise();
  await closeDatabase();
});

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

async function rolesFromProvider(on: boolean) {
  await patchEnterprise({ oidc: normalizeOidc({ enabled: true, issuer: ISSUER, client_id: "hub", app_roles: on }) });
}

async function account(data: TestData, options: { linked?: boolean; emergencyAccess?: boolean; isOwner?: boolean } = {}) {
  const user = await data.user({ isOwner: options.isOwner });
  const password = await givePassword(user.id);
  const { secret, recoveryCodes } = await enrollTotp(user.id);
  if (options.linked) {
    await prisma.userIdentity.create({ data: { userId: user.id, issuer: ISSUER, subject: uniqueName("sub") } });
  }
  if (options.emergencyAccess) await prisma.user.update({ where: { id: user.id }, data: { emergencyAccess: true } });
  return { user, password, secret, recoveryCodes };
}

async function admin(data: TestData) {
  const created = await account(data);
  const roleId = await templateRoleId("admin");
  const user = await prisma.user.update({ where: { id: created.user.id }, data: { roleId } });
  return { ...created, user, session: sessionOf(user, { permissions: ["users:read", "users:manage", "users:security"] }) };
}

async function signInLocally(person: { user: { email: string }; password: string; secret: string }, timeStep = 0) {
  setRequestHeaders({ "x-forwarded-for": documentationAddress(), "user-agent": "integration-test" });
  const step = await passwordSignIn({ email: person.user.email, password: person.password });
  assert.equal(step.step, "verify");
  const code = await totpCode(person.secret, timeStep);
  return withDeferredWork(() => verifyLoginSecondFactor({ method: "totp", code }));
}

async function runDeferred(deferred: (() => unknown)[]) {
  const posted: { url: string; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    posted.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    for (const task of deferred) await task();
  } finally {
    globalThis.fetch = realFetch;
  }
  return posted;
}

test("a provider-linked account signs in only through the provider while roles come from it", async () => {
  const data = new TestData();
  const jar = await cookies();
  try {
    await rolesFromProvider(false);
    const linked = await account(data, { linked: true });
    const provisioned = await account(data);
    await prisma.user.update({ where: { id: provisioned.user.id }, data: { externalId: uniqueName("scim") } });

    const before = await signInLocally(linked);
    assert.equal(before.result.step, "done");
    assert.equal((await getSession()).error, false);

    await rolesFromProvider(true);
    assert.equal((await getSession()).error, true);
    for (const person of [linked, provisioned]) {
      setRequestHeaders({ "x-forwarded-for": documentationAddress() });
      await assert.rejects(passwordSignIn({ email: person.user.email, password: person.password }), authError("SSO_REQUIRED"));
    }
    assert.ok(await prisma.user.findUniqueOrThrow({ where: { id: linked.user.id }, select: { password: true } }));

    await rolesFromProvider(false);
    const again = await signInLocally(linked, 1);
    assert.equal(again.result.step, "done");
    assert.equal(again.deferred.length, 0);
    assert.equal(
      await prisma.userSecurityEvent.count({ where: { userId: linked.user.id, action: "emergency_access.sign_in" } }),
      0,
    );
  } finally {
    jar.delete(SESSION_COOKIE);
    await rolesFromProvider(false);
    await data.cleanup();
  }
});

test("an emergency-access account signs in locally with a second factor, audited and announced to the other admins", async () => {
  const data = new TestData();
  const jar = await cookies();
  try {
    const manager = await admin(data);
    await patchEnterprise({
      alert_webhooks: [{ id: "emergency", url: WEBHOOK_URL, secret: "", format: "json", events: ["emergency_sign_in"] }],
    });
    await rolesFromProvider(true);
    const local = await account(data);
    const marked = await account(data, { linked: true, emergencyAccess: true });

    for (const person of [local, marked]) {
      const signedIn = await signInLocally(person);
      assert.equal(signedIn.result.step, "done");
      const event = await prisma.userSecurityEvent.findFirstOrThrow({
        where: { userId: person.user.id, action: "emergency_access.sign_in" },
      });
      assert.equal(event.actor, `user:${person.user.id}`);
      const audit = await prisma.gatewayAuditLog.findFirstOrThrow({
        where: { objectId: person.user.id, action: "user.emergency_sign_in" },
      });
      assert.equal(audit.afterJson, JSON.stringify({ method: "TOTP" }));

      const posted = await runDeferred(signedIn.deferred);
      assert.equal(posted.length, 1);
      assert.equal(posted[0].url, WEBHOOK_URL);
      assert.match(posted[0].body, new RegExp(person.user.email.replace(/[.]/g, "\\.")));
      const mail = capturedMail.find((message) => message.data.includes(person.user.email));
      assert.ok(mail, "no notification mail");
      assert.ok(mail.recipients.includes(manager.user.email));
      assert.ok(!mail.recipients.includes(person.user.email));
      assert.match(mail.data, /Subject: Emergency sign-in to LLM Hub/);
    }
  } finally {
    jar.delete(SESSION_COOKIE);
    await patchEnterprise({ alert_webhooks: [] });
    await rolesFromProvider(false);
    await data.cleanup();
  }
});

test("granting emergency access needs a step-up code and is limited to a few accounts", async () => {
  const data = new TestData();
  try {
    const manager = await admin(data);
    const [first, second, third, fourth] = await Promise.all([1, 2, 3, 4].map(() => account(data, { linked: true })));
    const codes = [...manager.recoveryCodes];
    setRequestHeaders({ "x-forwarded-for": documentationAddress() });

    await assert.rejects(setEmergencyAccess(manager.session, { userId: first.user.id, enabled: true, code: "" }), authError("VALIDATION"));
    await assert.rejects(
      setEmergencyAccess(manager.session, { userId: first.user.id, enabled: true, code: "999999" }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: first.user.id } })).emergencyAccess, false);

    for (const person of [first, second, third]) {
      await setEmergencyAccess(manager.session, { userId: person.user.id, enabled: true, code: codes.shift() });
    }
    const granted = await prisma.userSecurityEvent.findFirstOrThrow({
      where: { userId: first.user.id, action: "emergency_access.granted" },
    });
    assert.equal(granted.actor, `user:${manager.user.id}`);
    await prisma.gatewayAuditLog.findFirstOrThrow({
      where: { objectId: first.user.id, action: "user.emergency_access", actor: manager.user.id },
    });
    await assert.rejects(
      setEmergencyAccess(manager.session, { userId: fourth.user.id, enabled: true, code: codes.shift() }),
      authError("EMERGENCY_ACCESS_LIMIT"),
    );

    await setEmergencyAccess(manager.session, { userId: third.user.id, enabled: false, code: codes.shift() });
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: third.user.id } })).emergencyAccess, false);
    await prisma.userSecurityEvent.findFirstOrThrow({ where: { userId: third.user.id, action: "emergency_access.removed" } });
    await setEmergencyAccess(manager.session, { userId: fourth.user.id, enabled: true, code: codes.shift() });
  } finally {
    await data.cleanup();
  }
});

test("the owner stays an emergency-access account that cannot be blocked, deleted, unmarked, or linked to the provider", async () => {
  const data = new TestData();
  const jar = await cookies();
  try {
    const manager = await admin(data);
    const owner = await account(data, { isOwner: true });
    await rolesFromProvider(true);

    const signedIn = await signInLocally(owner);
    assert.equal(signedIn.result.step, "done");
    await prisma.userSecurityEvent.findFirstOrThrow({ where: { userId: owner.user.id, action: "emergency_access.sign_in" } });

    setRequestHeaders({ "x-forwarded-for": documentationAddress() });
    await assert.rejects(setUserBlocked(manager.session, owner.user.id, true), authError("OWNER_PROTECTED"));
    await assert.rejects(deleteUser(manager.session, owner.user.id), authError("OWNER_PROTECTED"));
    await assert.rejects(
      setEmergencyAccess(manager.session, { userId: owner.user.id, enabled: false, code: manager.recoveryCodes[0] }),
      authError("OWNER_PROTECTED"),
    );
    const identity = { issuer: ISSUER, subject: uniqueName("sub"), email: owner.user.email, groups: [], appRoles: ["admin"], externalIds: [] };
    await assert.rejects(
      signInWithSso(identity, normalizeOidc({ enabled: true, issuer: ISSUER, client_id: "hub", app_roles: true }), null),
      (err: unknown) => err instanceof SsoError && err.reason === "owner",
    );
    assert.equal(await prisma.userIdentity.count({ where: { userId: owner.user.id } }), 0);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    assert.equal(stored.blocked, false);
    assert.equal(stored.isOwner, true);
  } finally {
    jar.delete(SESSION_COOKIE);
    await rolesFromProvider(false);
    await data.cleanup();
  }
});
