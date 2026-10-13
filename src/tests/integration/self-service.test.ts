import "./support/request-scope";
import "./support/mail-env";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { verifyPassword } from "@/lib/auth/password";
import { ensureSystemCatalog } from "@/lib/bootstrap/system-catalog";
import { digest, randomToken } from "@/lib/crypto";
import { patchEnterprise } from "@/lib/settings/enterprise";
import { loginContextAction } from "@/app/account/login/_action";
import { isActionFail } from "@/lib/http/action-result";
import { POST as register } from "@/app/internal-api/account/register/route";
import { POST as forgotPassword } from "@/app/internal-api/account/forgot-password/route";
import { POST as resetPassword } from "@/app/internal-api/account/reset-password/route";
import { closeDatabase, uniqueName } from "./support/database";
import { documentationAddress, givePassword } from "./support/factors";
import { preserveSetting, TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";
import { withDeferredWork } from "./support/request-scope";

const ORIGIN = new URL(env.NEXT_PUBLIC_APP_URL).origin;
let restoreEnterprise: () => Promise<void>;

before(async () => {
  restoreEnterprise = await preserveSetting("enterprise");
  await ensureSystemCatalog();
});

after(async () => {
  await restoreEnterprise();
  await closeDatabase();
});

beforeEach(() => setRequestHeaders({}));

function post(path: string, body: unknown, ip: string) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

async function problem(res: Response) {
  assert.equal(res.headers.get("content-type"), "application/problem+json");
  return (await res.json()).code as string;
}

function account() {
  const username = uniqueName("self");
  return { username, email: `${username}@example.test`, password: "Sturdy-pass-8146q" };
}

test("self-registration is off unless enabled and refuses before reading the request", async () => {
  const data = new TestData();
  const ip = documentationAddress();
  data.ownAttempts(`register:${ip}`);
  try {
    await data.user();
    await prisma.setting.update({ where: { key: "enterprise" }, data: { value: "{}" } });

    const context = await loginContextAction();
    assert.ok(!isActionFail(context));
    assert.equal(context.registrationEnabled, false);

    const res = await register(post("/internal-api/account/register", { nonsense: true }, ip));
    assert.equal(res.status, 403);
    assert.equal(await problem(res), "REGISTRATION_DISABLED");
    assert.equal(await prisma.loginAttempt.count({ where: { key: `register:${ip}` } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("enabled self-registration creates a viewer who must enroll a second factor", async () => {
  const data = new TestData();
  const ip = documentationAddress();
  data.ownAttempts(`register:${ip}`);
  const input = account();
  try {
    await data.user();
    await patchEnterprise({ registration_enabled: true });
    setRequestHeaders({ "x-forwarded-for": ip });
    const context = await loginContextAction();
    assert.ok(!isActionFail(context));
    assert.equal(context.registrationEnabled, true);

    const weak = await register(post("/internal-api/account/register", { ...input, password: `${input.username}9` }, ip));
    assert.equal(await problem(weak), "PASSWORD_GUESSABLE");

    const res = await register(post("/internal-api/account/register", input, ip));
    assert.deepEqual(await res.json(), { redirect: "/account/login" });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: input.email }, include: { role: true } });
    data.ownUser(user.id);
    assert.equal(user.role?.templateKey, "viewer");
    assert.equal(user.isOwner, false);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id, purpose: "ENROLL" } }), 1);

    const duplicate = await register(post("/internal-api/account/register", input, ip));
    assert.equal(duplicate.status, 409);
    assert.equal(await problem(duplicate), "USER_EXISTS");
  } finally {
    await data.cleanup();
  }
});

test("a client may register twenty times per hour", async () => {
  const data = new TestData();
  const ip = documentationAddress();
  data.ownAttempts(`register:${ip}`);
  try {
    const existing = await data.user();
    await patchEnterprise({ registration_enabled: true });
    const clash = { ...account(), email: existing.email };
    for (let attempt = 0; attempt < 20; attempt += 1) {
      assert.equal(await problem(await register(post("/internal-api/account/register", clash, ip))), "USER_EXISTS");
    }
    const limited = await register(post("/internal-api/account/register", account(), ip));
    assert.equal(limited.status, 429);
    assert.equal(await problem(limited), "RATE_LIMITED");
  } finally {
    await data.cleanup();
  }
});

test("password reset answers the same for every address and mails from a deferred task", async (t) => {
  const data = new TestData();
  const ip = documentationAddress();
  const unknown = `${uniqueName("nobody")}@example.test`;
  data.ownAttempts(`reset-ip:${ip}`, `reset:${digest(unknown)}`);
  try {
    const user = await data.user();
    data.ownAttempts(`reset:${digest(user.email)}`);
    const stale = await prisma.passwordResetToken.create({
      data: { userId: user.id, hash: digest(randomToken()), expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const known = await withDeferredWork(() => forgotPassword(post("/internal-api/account/forgot-password", { email: user.email }, ip)));
    const missing = await withDeferredWork(() => forgotPassword(post("/internal-api/account/forgot-password", { email: unknown }, ip)));

    assert.deepEqual(await known.result.json(), { ok: true });
    assert.deepEqual(await missing.result.json(), { ok: true });
    assert.equal(known.result.status, missing.result.status);
    assert.deepEqual(
      (await prisma.passwordResetToken.findMany({ where: { userId: user.id }, select: { id: true } })).map((row) => row.id),
      [stale.id],
    );

    const lines: string[] = [];
    t.mock.method(console, "log", (line: string) => lines.push(line));
    t.mock.method(console, "error", (line: string) => lines.push(line));
    for (const task of [...known.deferred, ...missing.deferred]) await task();
    t.mock.restoreAll();

    const tokens = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    assert.equal(tokens.length, 1);
    assert.notEqual(tokens[0].id, stale.id);
    assert.ok(tokens[0].expiresAt.getTime() <= Date.now() + 3_600_000);
    const failure = lines.map((line) => JSON.parse(line)).find((entry) => entry.event === "auth.reset_token.mail_failed");
    assert.equal(failure?.userId, user.id);
    for (const line of lines) {
      assert.doesNotMatch(line, new RegExp(`${user.email}|${unknown}|reset-password\\?token|${tokens[0].hash}`));
    }
  } finally {
    await data.cleanup();
  }
});

test("password reset requests are limited per address and per client", async () => {
  const data = new TestData();
  const email = `${uniqueName("nobody")}@example.test`;
  const ips = [documentationAddress(), documentationAddress()];
  data.ownAttempts(...ips.map((ip) => `reset-ip:${ip}`), `reset:${digest(email)}`);
  const request = (address: string, ip: string) =>
    withDeferredWork(() => forgotPassword(post("/internal-api/account/forgot-password", { email: address }, ip)));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await request(email, ips[0])).result.status, 200);
    }
    const perAddress = (await request(email, ips[0])).result;
    assert.equal(perAddress.status, 429);
    assert.equal(await problem(perAddress), "RATE_LIMITED");

    const others = Array.from({ length: 11 }, () => `${uniqueName("other")}@example.test`);
    data.ownAttempts(...others.map((other) => `reset:${digest(other)}`));
    for (const other of others.slice(0, 10)) {
      assert.equal((await request(other, ips[1])).result.status, 200);
    }
    const perClient = await request(others[10], ips[1]);
    assert.equal(perClient.result.status, 429);
    assert.deepEqual(perClient.deferred, []);
  } finally {
    await data.cleanup();
  }
});

test("a reset token works once, applies the password policy, and ends every session", async () => {
  const data = new TestData();
  const ip = documentationAddress();
  try {
    const user = await data.user();
    const current = await givePassword(user.id);
    const token = randomToken();
    await prisma.passwordResetToken.createMany({
      data: [
        { userId: user.id, hash: digest(token), expiresAt: new Date(Date.now() + 3_600_000) },
        { userId: user.id, hash: digest(randomToken()), expiresAt: new Date(Date.now() + 3_600_000) },
      ],
    });
    await prisma.session.create({
      data: { userId: user.id, tokenHash: uniqueName("token"), secondFactor: "TOTP", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    const expired = randomToken();
    const other = await data.user();
    await prisma.passwordResetToken.create({
      data: { userId: other.id, hash: digest(expired), expiresAt: new Date(Date.now() - 1_000) },
    });
    const reset = (body: unknown) => resetPassword(post("/internal-api/account/reset-password", body, ip));
    const hexName = user.username.split("-").at(-1);

    assert.equal(await problem(await reset({ token, password: `${hexName}Kx7` })), "PASSWORD_GUESSABLE");
    assert.equal(await problem(await reset({ token, password: current })), "PASSWORD_REUSED");
    assert.equal(await problem(await reset({ token: expired, password: "Another-pass-3391" })), "INVALID_TOKEN");

    const done = await reset({ token, password: "Another-pass-3391" });
    assert.deepEqual(await done.json(), { ok: true });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await verifyPassword(updated.password, "Another-pass-3391"), true);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id, action: "password.reset" } }), 1);

    assert.equal(await problem(await reset({ token, password: "Third-pass-7720x" })), "INVALID_TOKEN");
  } finally {
    await data.cleanup();
  }
});
