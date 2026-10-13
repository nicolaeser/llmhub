import assert from "node:assert/strict";
import { after, test } from "node:test";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { AuthError } from "@/lib/auth/errors";
import { finishPasskeyRegistration, startPasskeyRegistration } from "@/lib/auth/account-security";
import { verifyPasskeyAssertion } from "@/lib/auth/passkeys";
import { digest } from "@/lib/crypto";
import {
  passkeySecondFactorOptions,
  passwordlessOptions,
  passwordSignIn,
  verifyPasskeySecondFactor,
  verifyPasswordless,
} from "@/lib/auth/sign-in";
import { closeDatabase } from "./support/database";
import { softwareAuthenticator } from "./support/authenticator";
import { documentationAddress, enrollTotp, givePassword, secondFactorFailures, totpCode } from "./support/factors";
import { sessionOf, TestData } from "./support/fixtures";
import { setRequestHeaders } from "./support/next-request.mjs";

after(closeDatabase);

const authError = (code: string) => (err: unknown) => err instanceof AuthError && err.code === code;

function fromClient() {
  setRequestHeaders({ "x-forwarded-for": documentationAddress() });
}

async function storedPasskey(userId: string) {
  const authenticator = softwareAuthenticator(new URL(env.NEXT_PUBLIC_APP_URL).origin);
  const passkey = await prisma.userPasskey.create({
    data: {
      userId,
      credentialId: authenticator.credentialId,
      credentialIdHash: digest(authenticator.credentialId),
      publicKey: authenticator.coseKey,
      name: "security key",
    },
  });
  return { authenticator, passkey };
}

test("registering a passkey needs user verification and consumes its challenge once", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { secret } = await enrollTotp(user.id);
    const session = sessionOf(user);
    const authenticator = softwareAuthenticator(new URL(env.NEXT_PUBLIC_APP_URL).origin);
    fromClient();

    const first = await startPasskeyRegistration(session, { code: await totpCode(secret) });
    await assert.rejects(
      finishPasskeyRegistration(session, {
        name: "laptop",
        response: authenticator.attestation(first.challenge, { userVerified: false }),
      }),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );
    await assert.rejects(
      finishPasskeyRegistration(session, { name: "laptop", response: authenticator.attestation(first.challenge) }),
      authError("PASSKEY_CHALLENGE_EXPIRED"),
    );
    assert.equal(await prisma.userPasskey.count({ where: { userId: user.id } }), 0);

    const second = await startPasskeyRegistration(session, { code: await totpCode(secret, 1) });
    const registered = await finishPasskeyRegistration(session, {
      name: "laptop",
      response: authenticator.attestation(second.challenge),
    });
    const stored = await prisma.userPasskey.findUniqueOrThrow({ where: { id: registered.id } });
    assert.equal(stored.credentialId, authenticator.credentialId);
    assert.equal(await prisma.userSecurityEvent.count({ where: { userId: user.id, action: "passkey.added" } }), 1);
  } finally {
    await data.cleanup();
  }
});

test("a passkey completes the second step of a password sign-in", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const password = await givePassword(user.id);
    await enrollTotp(user.id);
    const { authenticator, passkey } = await storedPasskey(user.id);
    fromClient();

    const step = await passwordSignIn({ email: user.email, password });
    assert.deepEqual(step.step === "verify" && step.methods, ["totp", "recovery", "passkey"]);
    const options = await passkeySecondFactorOptions();
    assert.deepEqual(
      options.allowCredentials?.map((credential) => credential.id),
      [authenticator.credentialId],
    );

    const result = await verifyPasskeySecondFactor({ response: authenticator.assertion(options.challenge, { counter: 1 }) });

    assert.deepEqual(result, { step: "done", method: "PASSKEY", recoveryCodesRemaining: null });
    assert.deepEqual(
      (await prisma.session.findMany({ where: { userId: user.id } })).map((row) => row.secondFactor),
      ["PASSKEY"],
    );
    assert.equal((await prisma.userPasskey.findUniqueOrThrow({ where: { id: passkey.id } })).counter, BigInt(1));
  } finally {
    await data.cleanup();
  }
});

test("a passkey assertion advances the counter once and failures count against the second factor", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { authenticator, passkey } = await storedPasskey(user.id);
    const challenge = "c2VydmVyLWNoYWxsZW5nZS0wMDAwMDAwMDAwMDA";
    const assertion = authenticator.assertion(challenge, { counter: 5 });

    const results = await Promise.allSettled([
      verifyPasskeyAssertion(assertion, challenge, false, user.id),
      verifyPasskeyAssertion(assertion, challenge, false, user.id),
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
    assert.equal((await prisma.userPasskey.findUniqueOrThrow({ where: { id: passkey.id } })).counter, BigInt(5));
    const failuresBefore = await secondFactorFailures(user.id);
    await assert.rejects(
      verifyPasskeyAssertion(assertion, challenge, false, user.id),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );
    await assert.rejects(
      verifyPasskeyAssertion(authenticator.assertion(challenge, { counter: 6 }), "b3RoZXItY2hhbGxlbmdlLTAwMDAwMDAwMDA", false, user.id),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );
    assert.equal(await secondFactorFailures(user.id), failuresBefore + 2);

    const stranger = await data.user();
    await assert.rejects(
      verifyPasskeyAssertion(authenticator.assertion(challenge, { counter: 7 }), challenge, false, stranger.id),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );
    assert.equal(await secondFactorFailures(stranger.id), 1);
  } finally {
    await data.cleanup();
  }
});

test("passwordless sign-in requires user verification and an enrolled second factor", async () => {
  const data = new TestData();
  try {
    const user = await data.user();
    const { authenticator } = await storedPasskey(user.id);
    fromClient();

    const unverified = await passwordlessOptions();
    await assert.rejects(
      verifyPasswordless({ response: authenticator.assertion(unverified.challenge, { counter: 1, userVerified: false }) }),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );

    const unenrolled = await passwordlessOptions();
    await assert.rejects(
      verifyPasswordless({ response: authenticator.assertion(unenrolled.challenge, { counter: 2 }) }),
      authError("PASSKEY_VERIFICATION_FAILED"),
    );
    assert.equal(await prisma.session.count({ where: { userId: user.id } }), 0);

    await enrollTotp(user.id);
    const verified = await passwordlessOptions();
    assert.deepEqual(
      await verifyPasswordless({ response: authenticator.assertion(verified.challenge, { counter: 3 }) }),
      { step: "done", method: "PASSKEY", recoveryCodesRemaining: null },
    );
    await assert.rejects(
      verifyPasswordless({ response: authenticator.assertion(verified.challenge, { counter: 4 }) }),
      authError("PASSKEY_CHALLENGE_EXPIRED"),
    );
    assert.deepEqual(
      (await prisma.session.findMany({ where: { userId: user.id } })).map((row) => row.secondFactor),
      ["PASSKEY"],
    );
  } finally {
    await data.cleanup();
  }
});
