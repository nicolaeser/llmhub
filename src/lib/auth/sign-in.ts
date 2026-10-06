import "server-only";
import prisma from "@/lib/db/prisma";
import { AuthError, isPrismaCode, parseAuthInput } from "@/lib/auth/errors";
import { digest, randomToken } from "@/lib/crypto";
import { assertPasswordPolicy, hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  newSessionToken,
  pruneSessions,
  requestMeta,
  setSessionCookie,
  startSession,
} from "@/lib/auth/session";
import {
  advanceToPasswordStep,
  challengeExpired,
  clearLoginChallenge,
  consumeLoginChallenge,
  currentLoginChallenge,
  issueLoginChallenge,
  reserveChallengeAttempt,
} from "@/lib/auth/login-challenge";
import {
  consumePasswordlessCeremony,
  passkeyAuthenticationOptions,
  passkeyChallengeExpired,
  passkeyFailed,
  passkeysAvailable,
  startPasswordlessCeremony,
  verifyPasskeyAssertion,
} from "@/lib/auth/passkeys";
import { newRecoveryCodes } from "@/lib/auth/recovery-codes";
import {
  guardSecondFactor,
  remainingRecoveryCodes,
  verifySecondFactor,
} from "@/lib/auth/second-factor";
import {
  LOGIN_ATTEMPT_WINDOW_MS,
  assertRequestRate,
  clearFailedAttempts,
  releaseAttempts,
  reserveAttempts,
  secondFactorThrottle,
} from "@/lib/auth/throttle";
import {
  matchTotp,
  newTotpSecret,
  openTotpSecret,
  sealTotpSecret,
  totpEnrollment,
} from "@/lib/auth/totp";
import { securityEvent, userActor } from "@/lib/auth/security-events";
import {
  passkeyAssertionSchema,
  passwordSignInSchema,
  requiredPasswordChangeSchema,
  secondFactorProofSchema,
  totpCodeSchema,
} from "@/schemas/auth";
import type { EnrollmentConfirmation, LoginChallengeRecord, LoginMethod, LoginResult, LoginStep, SecondFactorMethod, TotpEnrollment } from "@/types/security";

const ENROLLMENT_WINDOW_MS = 15 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const CLIENT_SIGN_INS_PER_MINUTE = 30;
const CLIENT_FAILURES = 10;
const ACCOUNT_FAILURES = 50;
const ENROLLMENT_STARTS = 10;
const CLIENT_PASSKEY_LOGINS_PER_MINUTE = 20;
const PASSKEY_LOGINS_PER_MINUTE = 120;
const secondFactorMethods: readonly SecondFactorMethod[] = ["TOTP", "RECOVERY", "PASSKEY"];

let dummyHash: Promise<string> | null = null;

async function verifyMethods(userId: string): Promise<LoginMethod[]> {
  if (!passkeysAvailable()) return ["totp", "recovery"];
  const passkeys = await prisma.userPasskey.count({ where: { userId } });
  return passkeys ? ["totp", "recovery", "passkey"] : ["totp", "recovery"];
}

async function assertPasswordlessRate() {
  const { ipAddress } = await requestMeta();
  await assertRequestRate(
    `passkey-login:${ipAddress ?? "unknown"}`,
    CLIENT_PASSKEY_LOGINS_PER_MINUTE,
    MINUTE_MS,
  );
  await assertRequestRate("passkey-login", PASSKEY_LOGINS_PER_MINUTE, MINUTE_MS);
}

async function checkCredentials(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  dummyHash ??= hashPassword(randomToken());
  const valid = await verifyPassword(user?.password ?? (await dummyHash), password);
  return user && !user.blocked && valid ? user : null;
}

export async function issueEnrollmentChallenge(userId: string): Promise<LoginStep> {
  const { expiresAt } = await issueLoginChallenge(userId, "ENROLL");
  return { step: "enroll", expiresAt: expiresAt.toISOString() };
}

export async function passwordSignIn(raw: unknown): Promise<LoginResult> {
  const input = parseAuthInput(passwordSignInSchema, raw);
  const meta = await requestMeta();
  const client = meta.ipAddress ?? "unknown";
  await assertRequestRate(`login:${client}`, CLIENT_SIGN_INS_PER_MINUTE, MINUTE_MS);
  const account = `login:${digest(input.email)}`;
  const throttleKey = `${account}:${client}`;
  const reservation = await reserveAttempts([
    { key: throttleKey, limit: CLIENT_FAILURES, windowMs: LOGIN_ATTEMPT_WINDOW_MS },
    { key: account, limit: ACCOUNT_FAILURES, windowMs: LOGIN_ATTEMPT_WINDOW_MS },
  ]);
  const user = await checkCredentials(input.email, input.password).catch(async (error: unknown) => {
    await releaseAttempts(reservation);
    throw error;
  });
  if (!user) throw new AuthError("INVALID_CREDENTIALS");
  await clearFailedAttempts(throttleKey);
  await releaseAttempts(reservation);
  if ((await secondFactorThrottle(user.id)).blocked) throw new AuthError("SECOND_FACTOR_LOCKED");
  const totp = await prisma.userTotp.findUnique({
    where: { userId: user.id },
    select: { enabledAt: true },
  });
  if (!totp?.enabledAt) {
    const { expiresAt } = await issueLoginChallenge(user.id, "ENROLL");
    return { step: "enroll", expiresAt: expiresAt.toISOString() };
  }
  const { expiresAt } = await issueLoginChallenge(user.id, "VERIFY");
  return {
    step: "verify",
    methods: await verifyMethods(user.id),
    expiresAt: expiresAt.toISOString(),
  };
}

export async function loginState(): Promise<LoginStep> {
  try {
    const challenge = await currentLoginChallenge();
    const expiresAt = challenge.expiresAt.toISOString();
    if (challenge.purpose === "ENROLL") return { step: "enroll", expiresAt };
    if (challenge.purpose === "PASSWORD") return { step: "password", expiresAt };
    return { step: "verify", methods: await verifyMethods(challenge.userId), expiresAt };
  } catch {
    return { step: null };
  }
}

export async function cancelSignIn(): Promise<LoginStep> {
  await clearLoginChallenge();
  return { step: null };
}

async function completeSignIn(
  challenge: LoginChallengeRecord,
  method: SecondFactorMethod,
): Promise<LoginResult> {
  if (challenge.user.mustChangePassword) {
    const { expiresAt } = await advanceToPasswordStep(
      challenge.id,
      challenge.purpose as "VERIFY" | "ENROLL",
      method,
    );
    return { step: "password", expiresAt: expiresAt.toISOString() };
  }
  await consumeLoginChallenge(challenge.id);
  await startSession(challenge.userId, method);
  await clearLoginChallenge();
  return {
    step: "done",
    method,
    recoveryCodesRemaining:
      method === "RECOVERY" ? await remainingRecoveryCodes(challenge.userId) : null,
  };
}

export async function startEnrollment(): Promise<TotpEnrollment> {
  const challenge = await currentLoginChallenge("ENROLL");
  const userId = challenge.userId;
  await assertRequestRate(`totp-enroll:${userId}`, ENROLLMENT_STARTS, ENROLLMENT_WINDOW_MS);
  const secret = newTotpSecret();
  const pendingSecret = sealTotpSecret(userId, secret);
  const pendingAt = new Date();
  const existing = await prisma.userTotp.findUnique({
    where: { userId },
    select: { enabledAt: true },
  });
  if (existing?.enabledAt) throw new AuthError("TWO_FACTOR_ALREADY_ENABLED");
  let stored = false;
  if (!existing) {
    try {
      await prisma.userTotp.create({ data: { userId, pendingSecret, pendingAt } });
      stored = true;
    } catch (error) {
      if (!isPrismaCode(error, "P2002")) throw error;
    }
  }
  if (!stored) {
    const { count } = await prisma.userTotp.updateMany({
      where: { userId, enabledAt: null },
      data: { pendingSecret, pendingAt },
    });
    if (count !== 1) throw new AuthError("TWO_FACTOR_ALREADY_ENABLED");
  }
  return {
    ...(await totpEnrollment(challenge.user.email, secret)),
    expiresAt: challenge.expiresAt.toISOString(),
  };
}

export async function confirmEnrollment(raw: unknown): Promise<EnrollmentConfirmation> {
  const { code } = parseAuthInput(totpCodeSchema, raw);
  const challenge = await currentLoginChallenge("ENROLL");
  const userId = challenge.userId;
  await reserveChallengeAttempt(challenge.id);
  const row = await prisma.userTotp.findUnique({
    where: { userId },
    select: { pendingSecret: true, pendingAt: true, enabledAt: true },
  });
  if (
    !row?.pendingSecret ||
    !row.pendingAt ||
    row.enabledAt ||
    Date.now() - row.pendingAt.getTime() > ENROLLMENT_WINDOW_MS
  ) {
    throw new AuthError("TWO_FACTOR_CHANGED");
  }
  const pendingSecret = row.pendingSecret;
  const step = await guardSecondFactor(userId, () =>
    matchTotp(openTotpSecret(userId, pendingSecret), code, null),
  );
  const mustChange = challenge.user.mustChangePassword;
  const meta = await requestMeta();
  let next: LoginResult;
  const session = mustChange ? null : newSessionToken();
  if (mustChange) {
    const { expiresAt } = await advanceToPasswordStep(challenge.id, "ENROLL", "TOTP");
    next = { step: "password", expiresAt: expiresAt.toISOString() };
  } else {
    await consumeLoginChallenge(challenge.id);
    await pruneSessions(userId);
    next = { step: "done", method: "TOTP", recoveryCodesRemaining: null };
  }
  const { codes, hashes } = newRecoveryCodes();
  try {
    await prisma.userTotp.update({
      where: { userId, pendingSecret: row.pendingSecret, enabledAt: null },
      data: {
        secret: row.pendingSecret,
        enabledAt: new Date(),
        lastTimeStep: step,
        pendingSecret: null,
        pendingAt: null,
        recoveryCodes: {
          deleteMany: {},
          createMany: { data: hashes.map((codeHash) => ({ codeHash })) },
        },
        user: {
          update: {
            ...(session
              ? {
                  sessions: {
                    create: {
                      tokenHash: session.tokenHash,
                      expiresAt: session.expiresAt,
                      secondFactor: "TOTP",
                      ipAddress: meta.ipAddress,
                      userAgent: meta.userAgent,
                    },
                  },
                }
              : {}),
            securityEvents: {
              create: securityEvent(userActor(userId), "2fa.enrolled", meta.ipAddress),
            },
          },
        },
      },
      select: { userId: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw new AuthError("TWO_FACTOR_CHANGED");
    throw error;
  }
  if (session) {
    await setSessionCookie(session.token, session.expiresAt);
    await clearLoginChallenge();
  }
  return { recoveryCodes: codes, next };
}

export async function verifyLoginSecondFactor(raw: unknown): Promise<LoginResult> {
  const proof = parseAuthInput(secondFactorProofSchema, raw);
  const challenge = await currentLoginChallenge("VERIFY");
  await reserveChallengeAttempt(challenge.id);
  const method = await verifySecondFactor(challenge.userId, proof);
  return completeSignIn(challenge, method);
}

export async function passkeySecondFactorOptions() {
  const challenge = await currentLoginChallenge("VERIFY");
  const passkeys = await prisma.userPasskey.findMany({
    where: { userId: challenge.userId },
    select: { credentialId: true, transports: true },
  });
  if (!passkeys.length) throw passkeyFailed();
  const options = await passkeyAuthenticationOptions(passkeys);
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id: challenge.id, consumedAt: null, purpose: "VERIFY" },
    data: { webauthnChallenge: options.challenge },
  });
  if (count !== 1) throw challengeExpired();
  return options;
}

export async function verifyPasskeySecondFactor(raw: unknown): Promise<LoginResult> {
  const { response } = parseAuthInput(passkeyAssertionSchema, raw);
  const challenge = await currentLoginChallenge("VERIFY");
  await reserveChallengeAttempt(challenge.id);
  const expected = challenge.webauthnChallenge;
  if (!expected) throw passkeyChallengeExpired();
  const { count } = await prisma.loginChallenge.updateMany({
    where: { id: challenge.id, webauthnChallenge: expected },
    data: { webauthnChallenge: null },
  });
  if (count !== 1) throw passkeyChallengeExpired();
  await verifyPasskeyAssertion(response, expected, false, challenge.userId);
  return completeSignIn(challenge, "PASSKEY");
}

export async function passwordlessOptions() {
  await assertPasswordlessRate();
  const options = await passkeyAuthenticationOptions(null);
  await startPasswordlessCeremony(options.challenge);
  return options;
}

export async function verifyPasswordless(raw: unknown): Promise<LoginResult> {
  const { response } = parseAuthInput(passkeyAssertionSchema, raw);
  await assertPasswordlessRate();
  const expected = await consumePasswordlessCeremony();
  if (!expected) throw passkeyChallengeExpired();
  const { userId } = await verifyPasskeyAssertion(response, expected, true);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      blocked: true,
      mustChangePassword: true,
      totp: { select: { enabledAt: true } },
    },
  });
  if (!user || user.blocked || !user.totp?.enabledAt) throw passkeyFailed();
  if (user.mustChangePassword) {
    const { expiresAt } = await issueLoginChallenge(userId, "PASSWORD", "PASSKEY");
    return { step: "password", expiresAt: expiresAt.toISOString() };
  }
  await startSession(userId, "PASSKEY");
  await clearLoginChallenge();
  return { step: "done", method: "PASSKEY", recoveryCodesRemaining: null };
}

export async function completePasswordChange(raw: unknown): Promise<LoginResult> {
  const { password } = parseAuthInput(requiredPasswordChangeSchema, raw);
  const challenge = await currentLoginChallenge("PASSWORD");
  assertPasswordPolicy(password, [challenge.user.email, challenge.user.username]);
  await reserveChallengeAttempt(challenge.id);
  const factor = secondFactorMethods.find((method) => method === challenge.factor);
  if (!factor) throw challengeExpired();
  const user = await prisma.user.findUnique({
    where: { id: challenge.userId },
    select: { password: true, totp: { select: { enabledAt: true } } },
  });
  if (!user) throw challengeExpired();
  if (!user.totp?.enabledAt) throw new AuthError("TWO_FACTOR_ENROLLMENT_REQUIRED");
  if (await verifyPassword(user.password, password)) throw new AuthError("PASSWORD_REUSED");
  const passwordHash = await hashPassword(password);
  await consumeLoginChallenge(challenge.id);
  await pruneSessions(challenge.userId);
  const session = newSessionToken();
  const meta = await requestMeta();
  try {
    await prisma.user.update({
      where: { id: challenge.userId, password: user.password },
      data: {
        password: passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        revision: { increment: 1 },
        sessions: {
          create: {
            tokenHash: session.tokenHash,
            expiresAt: session.expiresAt,
            secondFactor: factor,
            ipAddress: meta.ipAddress,
            userAgent: meta.userAgent,
          },
        },
        securityEvents: {
          create: securityEvent(userActor(challenge.userId), "password.changed", meta.ipAddress),
        },
      },
      select: { id: true },
    });
  } catch (error) {
    if (isPrismaCode(error, "P2025")) throw challengeExpired();
    throw error;
  }
  await setSessionCookie(session.token, session.expiresAt);
  await clearLoginChallenge();
  return { step: "done", method: factor, recoveryCodesRemaining: null };
}
