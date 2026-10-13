import assert from "node:assert/strict";
import { after, test } from "node:test";
import { cookies } from "next/headers";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { CHALLENGE_COOKIE, PASSKEY_COOKIE, SESSION_COOKIE } from "@/lib/auth/cookie";
import { verifySecondFactor } from "@/lib/auth/second-factor";
import { getSession } from "@/lib/auth/session";
import {
  completePasswordChange,
  confirmEnrollment,
  passwordlessOptions,
  passwordSignIn,
  startEnrollment,
  verifyLoginSecondFactor,
  verifyPasswordless,
} from "@/lib/auth/sign-in";
import { closeDatabase, uniqueName } from "./support/database";
import { documentationAddress, enrollTotp, givePassword, totpCode, wrongTotpCode } from "./support/factors";
import { TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

function fromClient(ip = documentationAddress()) {
  setRequestHeaders({ "x-forwarded-for": `203.0.113.9, ${ip}`, "user-agent": "integration-test" });
  return ip;
}

async function cookie(name: string) {
  return (await cookies()).get(name)?.value ?? "";
}

async function accountWithPassword(data: TestData, options: { totp?: boolean } = {}) {
  const user = await data.user();
  const password = await givePassword(user.id);
  const factors = options.totp === false ? null : await enrollTotp(user.id);
  return { user, password, secret: factors?.secret ?? "" };
}

test("the password step only issues a challenge and the second factor starts the session", async () => {
  const data = new TestData();
  try {
    const { user, password, secret } = await accountWithPassword(data);
    fromClient();

    const step = await passwordSignIn({ email: user.email, password });
    assert.equal(step.step, "verify");
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
    assert.equal(await cookie(SESSION_COOKIE), "");
    assert.notEqual(await cookie(CHALLENGE_COOKIE), "");
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id, purpose: "VERIFY" } }), 1);
    assert.equal((await getSession()).error, true);

    const code = await totpCode(secret);
    const done = await verifyLoginSecondFactor({ method: "totp", code });
    assert.deepEqual(done, { step: "done", method: "TOTP", recoveryCodesRemaining: null });
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].secondFactor, "TOTP");
    assert.equal(sessions[0].userAgent, "integration-test");
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
    const session = await getSession();
    assert.equal(session.error, false);
    assert.equal(!session.error && session.user.id, user.id);

    fromClient();
    await passwordSignIn({ email: user.email, password });
    await assert.rejects(verifyLoginSecondFactor({ method: "totp", code }), authError("INVALID_SECOND_FACTOR"));
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 1);
  } finally {
    await data.cleanup();
  }
});

test("a sign-in challenge allows five second-factor attempts", async () => {
  const data = new TestData();
  try {
    const { user, password, secret } = await accountWithPassword(data);
    fromClient();
    await passwordSignIn({ email: user.email, password });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        verifyLoginSecondFactor({ method: "totp", code: await wrongTotpCode(secret) }),
        authError("INVALID_SECOND_FACTOR"),
      );
    }
    await assert.rejects(
      verifyLoginSecondFactor({ method: "totp", code: await totpCode(secret) }),
      authError("LOGIN_CHALLENGE_EXPIRED"),
    );
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("accounts without an authenticator enroll before any session exists", async () => {
  const data = new TestData();
  try {
    const { user, password } = await accountWithPassword(data, { totp: false });
    fromClient();

    assert.equal((await passwordSignIn({ email: user.email, password })).step, "enroll");
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id, purpose: "ENROLL" } }), 1);
    await assert.rejects(verifyLoginSecondFactor({ method: "totp", code: "123456" }), authError("LOGIN_CHALLENGE_EXPIRED"));

    const enrollment = await startEnrollment();
    await assert.rejects(
      confirmEnrollment({ code: await wrongTotpCode(enrollment.secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await prisma.loginAttempt.count({ where: { key: `2fa:${user.id}` } }), 1);
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);

    const confirmed = await confirmEnrollment({ code: await totpCode(enrollment.secret) });
    assert.equal(confirmed.recoveryCodes.length, 10);
    assert.deepEqual(confirmed.next, { step: "done", method: "TOTP", recoveryCodesRemaining: null });
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    assert.deepEqual(sessions.map((row) => row.secondFactor), ["TOTP"]);
    assert.ok((await prisma.userTotp.findUniqueOrThrow({ where: { userId: user.id } })).enabledAt);
  } finally {
    await data.cleanup();
  }
});

test("wrong passwords, unknown accounts, and blocked users get the same answer", async () => {
  const data = new TestData();
  try {
    const { user, password } = await accountWithPassword(data);
    fromClient();
    await assert.rejects(passwordSignIn({ email: user.email, password: `${password}x` }), authError("INVALID_CREDENTIALS"));
    const nobody = `${uniqueName("nobody")}@example.test`;
    data.ownSignInAttempts(nobody);
    await assert.rejects(passwordSignIn({ email: nobody, password }), authError("INVALID_CREDENTIALS"));
    await prisma.user.update({ where: { id: user.id }, data: { blocked: true } });
    await assert.rejects(passwordSignIn({ email: user.email, password }), authError("INVALID_CREDENTIALS"));
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("ten failures from one client block that client before the password is checked", async () => {
  const data = new TestData();
  try {
    const { user, password } = await accountWithPassword(data);
    const wrong = { email: user.email, password: `${password}x` };
    const ip = fromClient();

    for (let attempt = 0; attempt < 9; attempt += 1) {
      await assert.rejects(passwordSignIn(wrong), authError("INVALID_CREDENTIALS"));
    }
    assert.equal((await passwordSignIn({ email: user.email, password })).step, "verify");
    const issued = await prisma.loginChallenge.findMany({ where: { userId: user.id }, select: { id: true } });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      fromClient(ip);
      await assert.rejects(passwordSignIn(wrong), authError("INVALID_CREDENTIALS"));
    }
    fromClient(ip);
    await assert.rejects(passwordSignIn({ email: user.email, password }), authError("RATE_LIMITED"));
    assert.deepEqual(await prisma.loginChallenge.findMany({ where: { userId: user.id }, select: { id: true } }), issued);

    fromClient();
    assert.equal((await passwordSignIn({ email: user.email, password })).step, "verify");
  } finally {
    await data.cleanup();
  }
});

test("fifty failures across clients block the account everywhere", async () => {
  const data = new TestData();
  try {
    const { user, password } = await accountWithPassword(data);
    const wrong = { email: user.email, password: `${password}x` };
    for (let client = 0; client < 10; client += 1) {
      const ip = documentationAddress();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        fromClient(ip);
        await assert.rejects(passwordSignIn(wrong), authError("INVALID_CREDENTIALS"));
      }
    }
    fromClient();
    await assert.rejects(passwordSignIn({ email: user.email, password }), authError("RATE_LIMITED"));
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("one client may start thirty sign-ins per minute across accounts", async () => {
  const data = new TestData();
  const unknownAccount = () => {
    const email = `${uniqueName("nobody")}@example.test`;
    data.ownSignInAttempts(email);
    return { email, password: "Whatever-123x" };
  };
  try {
    const ip = fromClient();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      fromClient(ip);
      await assert.rejects(passwordSignIn(unknownAccount()), authError("INVALID_CREDENTIALS"));
    }
    fromClient(ip);
    await assert.rejects(passwordSignIn(unknownAccount()), authError("RATE_LIMITED"));
  } finally {
    await data.cleanup();
  }
});

test("a locked second factor stops the password step", async () => {
  const data = new TestData();
  try {
    const { user, password, secret } = await accountWithPassword(data);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }).catch(() => null);
    }
    fromClient();
    await assert.rejects(passwordSignIn({ email: user.email, password }), authError("SECOND_FACTOR_LOCKED"));
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("a required password change checks the account's identifiers before the session starts", async () => {
  const data = new TestData();
  try {
    const { user, password, secret } = await accountWithPassword(data);
    await prisma.user.update({ where: { id: user.id }, data: { mustChangePassword: true } });
    fromClient();
    await passwordSignIn({ email: user.email, password });

    assert.equal((await verifyLoginSecondFactor({ method: "totp", code: await totpCode(secret) })).step, "password");
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);

    const hexName = user.username.split("-").at(-1);
    await assert.rejects(completePasswordChange({ password: `${hexName}Kx7` }), authError("PASSWORD_GUESSABLE"));
    await assert.rejects(completePasswordChange({ password }), authError("PASSWORD_REUSED"));
    assert.deepEqual(await completePasswordChange({ password: "Brand-new-pass-5150" }), {
      step: "done",
      method: "TOTP",
      recoveryCodesRemaining: null,
    });
    const sessions = await prisma.session.findMany({ where: { userId: user.id } });
    assert.deepEqual(sessions.map((row) => row.secondFactor), ["TOTP"]);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword, false);
  } finally {
    await data.cleanup();
  }
});

test("passwordless sign-in is rate limited per client and overall before a ceremony is stored", async () => {
  const challenges: string[] = [];
  try {
    fromClient();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      challenges.push((await passwordlessOptions()).challenge);
    }
    const ceremony = await cookie(PASSKEY_COOKIE);
    assert.notEqual(ceremony, "");
    await assert.rejects(passwordlessOptions(), authError("RATE_LIMITED"));
    await assert.rejects(verifyPasswordless({ response: {} }), authError("RATE_LIMITED"));
    assert.equal(await cookie(PASSKEY_COOKIE), ceremony);
    assert.equal(await prisma.authCeremony.count({ where: { challenge: challenges.at(-1) } }), 1);
    assert.equal(await prisma.authCeremony.count({ where: { challenge: { in: challenges.slice(0, -1) } } }), 0);

    for (let client = 0; client < 5; client += 1) {
      fromClient();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        challenges.push((await passwordlessOptions()).challenge);
      }
    }
    fromClient();
    await assert.rejects(passwordlessOptions(), authError("RATE_LIMITED"));
  } finally {
    await prisma.authCeremony.deleteMany({ where: { challenge: { in: challenges } } });
  }
});
