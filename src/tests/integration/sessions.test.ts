import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import {
  CHALLENGE_COOKIE,
  SESSION_COOKIE,
  SESSION_ABSOLUTE_TTL_MS,
  SESSION_IDLE_TTL_MS,
  signSessionToken,
} from "@/lib/auth/cookie";
import { purgeAuthRecords } from "@/lib/auth/cleanup";
import { getSession, setSessionCookie, startSession } from "@/lib/auth/session";
import { digest, randomToken } from "@/lib/crypto";
import { GET as expiredRoute } from "@/app/internal-api/account/expired/route";
import { POST as logoutRoute } from "@/app/internal-api/account/logout/route";
import { closeDatabase, uniqueName } from "./support/database";
import { TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);
beforeEach(() => setRequestHeaders({}));

const DAY_MS = 86_400_000;

async function storedSession(
  userId: string,
  overrides: { secondFactor?: string; lastActive?: Date; expiresAt?: Date; createdAt?: Date } = {},
) {
  const token = randomToken();
  const row = await prisma.session.create({
    data: {
      userId,
      tokenHash: digest(token),
      secondFactor: overrides.secondFactor ?? "TOTP",
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + DAY_MS),
      ...(overrides.lastActive ? { lastActive: overrides.lastActive } : {}),
      ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}),
    },
  });
  return { row, token, cookie: await signSessionToken(token) };
}

async function presentCookie(value: string) {
  (await cookies()).set(SESSION_COOKIE, value);
}

async function sessionFor(value: string) {
  setRequestHeaders({});
  await presentCookie(value);
  return getSession();
}

test("a stored session with a second factor resolves to its user and permissions", async () => {
  const data = new TestData();
  try {
    const org = await data.org();
    const user = await data.user({ orgId: org.id });
    const role = await prisma.role.create({
      data: { name: uniqueName("role"), permissions: ["keys:read", "users:manage", "tenancy:manage"] },
    });
    try {
      await prisma.user.update({ where: { id: user.id }, data: { roleId: role.id } });
      const { row, cookie } = await storedSession(user.id, { lastActive: new Date(Date.now() - 2 * 60_000) });

      const session = await sessionFor(cookie);
      assert.equal(session.error, false);
      if (session.error) return;
      assert.equal(session.sessionId, row.id);
      assert.equal(session.user.id, user.id);
      assert.equal(session.secondFactor, "TOTP");
      assert.deepEqual(session.permissions, ["keys:read", "tenancy:manage"]);
      const touched = await prisma.session.findUniqueOrThrow({ where: { id: row.id } });
      assert.ok(touched.lastActive > row.lastActive);
    } finally {
      await prisma.user.update({ where: { id: user.id }, data: { roleId: null } });
      await prisma.role.delete({ where: { id: role.id } });
    }
  } finally {
    await data.cleanup();
  }
});

test("sessions without a known factor, idle or expired sessions, and blocked users are rejected", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const now = Date.now();
    const rejected = [
      await storedSession(user.id, { secondFactor: "" }),
      await storedSession(user.id, { secondFactor: "PASSWORD" }),
      await storedSession(user.id, { lastActive: new Date(now - SESSION_IDLE_TTL_MS - 60_000) }),
      await storedSession(user.id, { expiresAt: new Date(now - 1_000) }),
    ];
    for (const { cookie } of rejected) {
      assert.equal((await sessionFor(cookie)).error, true);
    }

    const valid = await storedSession(user.id, { lastActive: new Date(now - SESSION_IDLE_TTL_MS + 60 * 60_000) });
    assert.equal((await sessionFor(valid.cookie)).error, false);
    const [token, signature] = valid.cookie.split(".");
    const forged = `${token}.${signature.slice(0, -1)}${signature.endsWith("0") ? "1" : "0"}`;
    assert.equal((await sessionFor(forged)).error, true);
    assert.equal((await sessionFor(valid.token)).error, true);
    assert.equal((await sessionFor(await signSessionToken(randomToken()))).error, true);

    await prisma.user.update({ where: { id: user.id }, data: { blocked: true } });
    assert.equal((await sessionFor(valid.cookie)).error, true);
  } finally {
    await data.cleanup();
  }
});

test("starting a session revokes the session the browser already held", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const previous = await storedSession(user.id);
    setRequestHeaders({ "x-forwarded-for": "198.51.100.20", "user-agent": "browser" });
    await presentCookie(previous.cookie);

    await startSession(user.id, "PASSKEY");

    assert.equal(await prisma.session.count({ where: { id: previous.row.id } }), 0);
    const current = await getSession();
    assert.equal(current.error, false);
    if (current.error) return;
    assert.notEqual(current.sessionId, previous.row.id);
    assert.equal(current.secondFactor, "PASSKEY");
    assert.equal(current.ipAddress, "198.51.100.20");

    const replacement = randomToken();
    await prisma.session.create({
      data: { userId: user.id, tokenHash: digest(replacement), secondFactor: "TOTP", expiresAt: new Date(Date.now() + DAY_MS) },
    });
    await setSessionCookie(replacement, new Date(Date.now() + SESSION_ABSOLUTE_TTL_MS));
    assert.equal(await prisma.session.count({ where: { id: current.sessionId } }), 0);
    assert.equal(await prisma.session.count({ where: { tokenHash: digest(replacement) } }), 1);
  } finally {
    await data.cleanup();
  }
});

test("the expired-session route clears the cookie only when the session is invalid", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const live = await storedSession(user.id);

    await presentCookie(live.cookie);
    const kept = await expiredRoute();
    assert.equal(new URL(kept.headers.get("location") ?? "").pathname, "/");
    assert.equal(kept.cookies.get(SESSION_COOKIE), undefined);

    setRequestHeaders({});
    await presentCookie((await storedSession(user.id, { expiresAt: new Date(Date.now() - 1_000) })).cookie);
    const cleared = await expiredRoute();
    assert.equal(new URL(cleared.headers.get("location") ?? "").pathname, "/account/login");
    assert.equal(cleared.cookies.get(SESSION_COOKIE)?.value, "");
    assert.equal(cleared.cookies.get(SESSION_COOKIE)?.maxAge, 0);
  } finally {
    await data.cleanup();
  }
});

test("logout revokes the session and drops the pending login challenge", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const live = await storedSession(user.id);
    const challenge = randomToken();
    await prisma.loginChallenge.create({
      data: { userId: user.id, tokenHash: digest(challenge), purpose: "VERIFY", expiresAt: new Date(Date.now() + 60_000) },
    });
    const origin = new URL(env.NEXT_PUBLIC_APP_URL).origin;
    const request = new NextRequest(`${origin}/internal-api/account/logout`, {
      method: "POST",
      headers: {
        origin,
        cookie: `${SESSION_COOKIE}=${live.cookie}; ${CHALLENGE_COOKIE}=${challenge}`,
      },
    });

    const res = await logoutRoute(request);

    assert.equal(res.status, 303);
    assert.equal(new URL(res.headers.get("location") ?? "").pathname, "/account/login");
    assert.equal(await prisma.session.count({ where: { id: live.row.id } }), 0);
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
    assert.equal(res.cookies.get(SESSION_COOKIE)?.value, "");
    assert.equal(res.cookies.get(CHALLENGE_COOKIE)?.value, "");
  } finally {
    await data.cleanup();
  }
});

test("the auth cleanup purges idle and expired sessions, stale challenges, ceremonies, and enrollments", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const pending = await data.user();
    const now = new Date();
    const at = now.getTime();
    await storedSession(user.id, { lastActive: new Date(at - SESSION_IDLE_TTL_MS - 1_000) });
    await storedSession(user.id, { expiresAt: new Date(at - 1_000) });
    const live = await storedSession(user.id);
    const challenge = (expiresAt: Date, consumedAt: Date | null = null) =>
      prisma.loginChallenge.create({
        data: { userId: user.id, tokenHash: uniqueName("challenge"), purpose: "VERIFY", expiresAt, consumedAt },
      });
    await challenge(new Date(at - 1_000));
    await challenge(new Date(at + 60_000), new Date(at - 2 * 3_600_000));
    const openChallenge = await challenge(new Date(at + 60_000));
    const ceremony = (expiresAt: Date) =>
      prisma.authCeremony.create({ data: { userId: user.id, purpose: "PASSKEY_REGISTER", challenge: uniqueName("c"), expiresAt } });
    await ceremony(new Date(at - 1_000));
    const openCeremony = await ceremony(new Date(at + 60_000));
    await prisma.userTotp.create({
      data: { userId: pending.id, pendingSecret: "sealed", pendingAt: new Date(at - 25 * 3_600_000) },
    });

    await purgeAuthRecords(now);

    const sessions = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
    assert.deepEqual(sessions, [{ id: live.row.id }]);
    const challenges = await prisma.loginChallenge.findMany({ where: { userId: user.id }, select: { id: true } });
    assert.deepEqual(challenges, [{ id: openChallenge.id }]);
    const ceremonies = await prisma.authCeremony.findMany({ where: { userId: user.id }, select: { id: true } });
    assert.deepEqual(ceremonies, [{ id: openCeremony.id }]);
    assert.equal(await prisma.userTotp.count({ where: { userId: pending.id } }), 0);
  } finally {
    await data.cleanup();
  }
});
