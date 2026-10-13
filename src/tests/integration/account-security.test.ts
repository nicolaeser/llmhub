import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { verifyPassword } from "@/lib/auth/password";
import { permissions } from "@/lib/auth/permissions";
import {
  changeOwnPassword,
  confirmTotpReplacement,
  regenerateRecoveryCodes,
  removeOwnPasskey,
  startPasskeyRegistration,
  startTotpReplacement,
} from "@/lib/auth/account-security";
import { resetUserTwoFactor, setUserPassword } from "@/lib/auth/users";
import { closeDatabase, uniqueName } from "./support/database";
import { enrollTotp, givePassword, secondFactorFailures, totpCode, wrongTotpCode } from "./support/factors";
import { sessionOf, TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);
beforeEach(() => setRequestHeaders({}));

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

function openSession(userId: string) {
  return prisma.session.create({
    data: {
      userId,
      tokenHash: uniqueName("token"),
      secondFactor: "TOTP",
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
}

async function signedInUser(data: TestData, options: { permissions?: typeof permissions } = {}) {
  const user = await data.user();
  const factors = await enrollTotp(user.id);
  const current = await openSession(user.id);
  const session = sessionOf(user, { permissions: options.permissions, sessionId: current.id });
  return { user, session, current, ...factors };
}

test("replacing the authenticator needs a step-up code and a code from the new secret", async () => {
  const data = new TestData();
  try {
    const { user, session, secret, current } = await signedInUser(data);
    await openSession(user.id);

    await assert.rejects(
      startTotpReplacement(session, { code: await wrongTotpCode(secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal((await prisma.userTotp.findUniqueOrThrow({ where: { userId: user.id } })).pendingSecret, null);

    const enrollment = await startTotpReplacement(session, { code: await totpCode(secret) });
    assert.notEqual(enrollment.secret, secret);

    await assert.rejects(
      confirmTotpReplacement(session, { code: await wrongTotpCode(enrollment.secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await secondFactorFailures(user.id), 1);

    assert.deepEqual(await confirmTotpReplacement(session, { code: await totpCode(enrollment.secret) }), {
      replaced: true,
    });
    const stored = await prisma.userTotp.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(stored.pendingSecret, null);
    assert.equal(typeof stored.lastTimeStep, "number");
    const sessions = await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } });
    assert.deepEqual(sessions, [{ id: current.id }]);
    await assert.rejects(
      startTotpReplacement(session, { code: await totpCode(secret, 1) }),
      authError("INVALID_SECOND_FACTOR"),
    );
  } finally {
    await data.cleanup();
  }
});

test("regenerating recovery codes needs a step-up code and invalidates the old codes", async () => {
  const data = new TestData();
  try {
    const { user, session, secret, recoveryCodes } = await signedInUser(data);
    const before = await prisma.recoveryCode.findMany({ where: { userId: user.id }, select: { codeHash: true } });

    await assert.rejects(regenerateRecoveryCodes(session, { code: "nope" }), authError("INVALID_SECOND_FACTOR"));
    assert.deepEqual(
      await prisma.recoveryCode.findMany({ where: { userId: user.id }, select: { codeHash: true } }),
      before,
    );

    const { recoveryCodes: fresh } = await regenerateRecoveryCodes(session, { code: await totpCode(secret) });
    assert.equal(fresh.length, recoveryCodes.length);
    await assert.rejects(
      regenerateRecoveryCodes(session, { code: recoveryCodes[0] }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(
      (await regenerateRecoveryCodes(session, { code: fresh[0] })).recoveryCodes.length,
      recoveryCodes.length,
    );
  } finally {
    await data.cleanup();
  }
});

test("adding or removing a passkey needs a step-up code", async () => {
  const data = new TestData();
  try {
    const { user, session, secret } = await signedInUser(data);
    const passkey = await prisma.userPasskey.create({
      data: {
        userId: user.id,
        credentialIdHash: uniqueName("credential"),
        credentialId: uniqueName("credential"),
        publicKey: Buffer.from("key"),
        name: "laptop",
      },
    });

    await assert.rejects(
      startPasskeyRegistration(session, { code: await wrongTotpCode(secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await prisma.authCeremony.count({ where: { userId: user.id } }), 0);

    await assert.rejects(
      removeOwnPasskey(session, { id: passkey.id, code: await wrongTotpCode(secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await prisma.userPasskey.count({ where: { id: passkey.id } }), 1);

    const options = await startPasskeyRegistration(session, { code: await totpCode(secret) });
    assert.equal(options.authenticatorSelection?.userVerification, "required");
    assert.equal(await prisma.authCeremony.count({ where: { userId: user.id, challenge: options.challenge } }), 1);

    assert.deepEqual(await removeOwnPasskey(session, { id: passkey.id, code: await totpCode(secret, 1) }), {
      removed: true,
    });
    assert.equal(await prisma.userPasskey.count({ where: { id: passkey.id } }), 0);
  } finally {
    await data.cleanup();
  }
});

test("changing the own password checks identifiers, is throttled, and signs out other sessions", async () => {
  const data = new TestData();
  try {
    const { user, current } = await signedInUser(data);
    const password = await givePassword(user.id);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const session = sessionOf(fresh, { sessionId: current.id });
    await openSession(user.id);
    const hexName = user.username.split("-").at(-1);

    await assert.rejects(
      changeOwnPassword(session, { currentPassword: password, newPassword: `${hexName}Kx7` }),
      authError("PASSWORD_GUESSABLE"),
    );
    await assert.rejects(
      changeOwnPassword(session, { currentPassword: password, newPassword: password }),
      authError("PASSWORD_REUSED"),
    );
    const next = `Nx-${uniqueName("pw").slice(-12)}-4k`;
    assert.deepEqual(await changeOwnPassword(session, { currentPassword: password, newPassword: next }), {
      changed: true,
    });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(await verifyPassword(updated.password, next), true);
    assert.deepEqual(
      await prisma.session.findMany({ where: { userId: user.id }, select: { id: true } }),
      [{ id: current.id }],
    );

    const stale = sessionOf(updated, { sessionId: current.id });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await assert.rejects(
        changeOwnPassword(stale, { currentPassword: "wrong-password-1", newPassword: `Zz-${attempt}-9q8w7e6r` }),
        authError("PASSWORD_INCORRECT"),
      );
    }
    await assert.rejects(
      changeOwnPassword(stale, { currentPassword: next, newPassword: "Yy-5-9q8w7e6r" }),
      authError("RATE_LIMITED"),
    );
  } finally {
    await data.cleanup();
  }
});

test("resetting another user's two-factor needs the actor's step-up code and clears the target", async () => {
  const data = new TestData();
  try {
    const actor = await signedInUser(data, { permissions: [...permissions] });
    const target = await data.user();
    const { secret: targetSecret } = await enrollTotp(target.id);
    await openSession(target.id);
    await prisma.loginAttempt.create({ data: { key: `2fa:${target.id}` } });

    await assert.rejects(
      resetUserTwoFactor(actor.session, { userId: target.id, code: await totpCode(targetSecret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await prisma.userTotp.count({ where: { userId: target.id } }), 1);
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 1);

    await resetUserTwoFactor(actor.session, { userId: target.id, code: await totpCode(actor.secret) });
    assert.equal(await prisma.userTotp.count({ where: { userId: target.id } }), 0);
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 0);
    assert.equal(await secondFactorFailures(target.id), 0);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: target.id, action: "2fa.reset" } }), 1);
  } finally {
    await data.cleanup();
  }
});

test("setting another user's password needs a step-up code, applies the policy, and ends their sessions", async () => {
  const data = new TestData();
  try {
    const actor = await signedInUser(data, { permissions: [...permissions] });
    const target = await data.user();
    await openSession(target.id);
    const hexName = target.username.split("-").at(-1);

    await assert.rejects(
      setUserPassword(actor.session, {
        userId: target.id,
        password: `${hexName}Kx7`,
        requireChange: false,
        code: await totpCode(actor.secret),
      }),
      authError("PASSWORD_GUESSABLE"),
    );
    await assert.rejects(
      setUserPassword(actor.session, {
        userId: target.id,
        password: "Fine-pass-4821x",
        requireChange: true,
        code: await wrongTotpCode(actor.secret),
      }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 1);

    await setUserPassword(actor.session, {
      userId: target.id,
      password: "Fine-pass-4821x",
      requireChange: true,
      code: await totpCode(actor.secret),
    });
    const updated = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    assert.equal(await verifyPassword(updated.password, "Fine-pass-4821x"), true);
    assert.equal(updated.mustChangePassword, true);
    assert.equal(await prisma.session.count({ where: { userId: target.id } }), 0);
  } finally {
    await data.cleanup();
  }
});
