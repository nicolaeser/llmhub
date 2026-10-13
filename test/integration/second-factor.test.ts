import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { AuthError } from "@/lib/auth/errors";
import { guardSecondFactor, requireStepUp, verifySecondFactor } from "@/lib/auth/second-factor";
import { closeDatabase } from "./support/database";
import { enrollTotp, secondFactorFailures, totpCode, wrongTotpCode } from "./support/factors";
import { TestData } from "./support/fixtures";

after(closeDatabase);

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

test("an accepted authenticator code is consumed and cannot be replayed", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);
    const code = await totpCode(secret);

    assert.equal(await verifySecondFactor(user.id, { method: "totp", code }), "TOTP");
    const stored = await prisma.userTotp.findUniqueOrThrow({ where: { userId: user.id } });
    assert.equal(typeof stored.lastTimeStep, "number");

    await assert.rejects(verifySecondFactor(user.id, { method: "totp", code }), authError("INVALID_SECOND_FACTOR"));
    assert.equal(await verifySecondFactor(user.id, { method: "totp", code: await totpCode(secret, 1) }), "TOTP");
  } finally {
    await data.cleanup();
  }
});

test("the same authenticator code submitted in parallel is accepted once", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);
    const code = await totpCode(secret);

    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => verifySecondFactor(user.id, { method: "totp", code })),
    );

    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    for (const result of results.filter((entry) => entry.status === "rejected")) {
      assert.ok(authError("INVALID_SECOND_FACTOR")(result.reason));
    }
  } finally {
    await data.cleanup();
  }
});

test("a recovery code signs in once, even in parallel, and is recorded", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { recoveryCodes } = await enrollTotp(user.id);
    const [first, second] = recoveryCodes;

    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => verifySecondFactor(user.id, { method: "recovery", code: first })),
    );
    assert.deepEqual(
      results.map((result) => result.status).sort(),
      ["fulfilled", "rejected", "rejected"],
    );
    await assert.rejects(
      verifySecondFactor(user.id, { method: "recovery", code: first.toUpperCase() }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(
      await verifySecondFactor(user.id, { method: "recovery", code: second.replace("-", "") }),
      "RECOVERY",
    );
    assert.equal(await prisma.recoveryCode.count({ where: { userId: user.id, usedAt: { not: null } } }), 2);
    assert.equal(
      await prisma.userSecurityEvent.count({ where: { userId: user.id, action: "2fa.recovery_used" } }),
      2,
    );
  } finally {
    await data.cleanup();
  }
});

test("a failed check keeps its attempt and a successful one clears the user's failures", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);

    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    await assert.rejects(
      verifySecondFactor(user.id, { method: "recovery", code: "0000-0000-0000-0000" }),
      authError("INVALID_SECOND_FACTOR"),
    );
    assert.equal(await secondFactorFailures(user.id), 2);

    await verifySecondFactor(user.id, { method: "totp", code: await totpCode(secret) });
    assert.equal(await secondFactorFailures(user.id), 0);
  } finally {
    await data.cleanup();
  }
});

test("errors unrelated to the code release the reserved attempt", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    await assert.rejects(
      guardSecondFactor(user.id, async () => {
        assert.equal(await secondFactorFailures(user.id), 1);
        throw new Error("verifier unavailable");
      }),
      /verifier unavailable/,
    );
    assert.equal(await secondFactorFailures(user.id), 0);
  } finally {
    await data.cleanup();
  }
});

test("the tenth failure locks second factors, ends pending sign-ins, and records the lock", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);
    await prisma.loginChallenge.create({
      data: {
        userId: user.id,
        tokenHash: `pending-${user.id}`,
        purpose: "VERIFY",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    for (let attempt = 1; attempt < 10; attempt += 1) {
      await assert.rejects(
        verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }),
        authError("INVALID_SECOND_FACTOR"),
      );
    }
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 1);

    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }),
      authError("SECOND_FACTOR_LOCKED"),
    );
    assert.equal(await prisma.loginChallenge.count({ where: { userId: user.id } }), 0);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id, action: "2fa.locked" } }), 1);

    let verified = false;
    await assert.rejects(
      guardSecondFactor(user.id, async () => {
        verified = true;
        return true;
      }),
      authError("SECOND_FACTOR_LOCKED"),
    );
    assert.equal(verified, false);
    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await totpCode(secret) }),
      authError("SECOND_FACTOR_LOCKED"),
    );
  } finally {
    await data.cleanup();
  }
});

test("parallel guesses cannot run more checks than the lockout allows", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    let checks = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 25 }, () =>
        guardSecondFactor(user.id, async () => {
          checks += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return null;
        }),
      ),
    );

    assert.ok(checks <= 10, `ran ${checks} checks`);
    assert.ok(results.every((result) => result.status === "rejected"));
    assert.ok(await secondFactorFailures(user.id) <= 10);
  } finally {
    await data.cleanup();
  }
});

test("step-up accepts a fresh authenticator or recovery code and counts empty codes as failures", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret, recoveryCodes } = await enrollTotp(user.id);

    await assert.rejects(requireStepUp(user.id, ""), authError("INVALID_SECOND_FACTOR"));
    await assert.rejects(requireStepUp(user.id, undefined), authError("INVALID_SECOND_FACTOR"));
    assert.equal(await secondFactorFailures(user.id), 2);

    assert.equal(await requireStepUp(user.id, ` ${await totpCode(secret)} `), "TOTP");
    assert.equal(await secondFactorFailures(user.id), 0);
    assert.equal(await requireStepUp(user.id, recoveryCodes[0]), "RECOVERY");
    await assert.rejects(requireStepUp(user.id, recoveryCodes[0]), authError("INVALID_SECOND_FACTOR"));

    const unenrolled = await data.user();
    await assert.rejects(requireStepUp(unenrolled.id, "123456"), authError("TWO_FACTOR_ENROLLMENT_REQUIRED"));
  } finally {
    await data.cleanup();
  }
});

test("thirty failures within a day lock second factors after the short window has passed", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);
    const failures = (count: number, hours: number) =>
      prisma.loginAttempt.createMany({
        data: Array.from({ length: count }, () => ({ key: `2fa:${user.id}`, createdAt: hoursAgo(hours) })),
      });
    await failures(28, 2);
    await failures(5, 25);

    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }),
      authError("INVALID_SECOND_FACTOR"),
    );
    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await wrongTotpCode(secret) }),
      authError("SECOND_FACTOR_LOCKED"),
    );
    await assert.rejects(
      verifySecondFactor(user.id, { method: "totp", code: await totpCode(secret) }),
      authError("SECOND_FACTOR_LOCKED"),
    );
  } finally {
    await data.cleanup();
  }
});
