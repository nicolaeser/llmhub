import "server-only";
import { cookies } from "next/headers";
import { isIP } from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import prisma from "@/lib/db/prisma";
import { env } from "@/lib/env";
import { AuthError, isPrismaCode } from "@/lib/auth/errors";
import { PASSKEY_COOKIE, ceremonyCookieOptions } from "@/lib/auth/cookie";
import { digest, randomToken } from "@/lib/crypto";
import { guardSecondFactor } from "@/lib/auth/second-factor";
import { securityEvent, userActor } from "@/lib/auth/security-events";
import {
  authenticationResponseSchema,
  registrationResponseSchema,
} from "@/schemas/auth";

const PASSKEY_RP_NAME = "LLM Hub";
const MAX_PASSKEYS = 10;
const CEREMONY_TTL_MS = 5 * 60 * 1000;
const REGISTER = "PASSKEY_REGISTER";
const LOGIN = "PASSKEY_LOGIN";

export const passkeyFailed = () => new AuthError("PASSKEY_VERIFICATION_FAILED");
export const passkeyChallengeExpired = () => new AuthError("PASSKEY_CHALLENGE_EXPIRED");

function relyingParty() {
  let url: URL;
  try {
    url = new URL(env.NEXT_PUBLIC_APP_URL);
  } catch {
    throw new AuthError("PASSKEYS_UNAVAILABLE");
  }
  const local = url.hostname === "localhost";
  if (!local && (url.protocol !== "https:" || isIP(url.hostname) !== 0)) {
    throw new AuthError("PASSKEYS_UNAVAILABLE");
  }
  return { rpID: url.hostname, origin: url.origin };
}

export function passkeysAvailable(): boolean {
  try {
    relyingParty();
    return true;
  } catch {
    return false;
  }
}

const credentialIdHash = (credentialId: string) => digest(credentialId);

const transportsOf = (value: string | null) =>
  value ? (value.split(",").filter(Boolean) as AuthenticatorTransport[]) : undefined;

export async function passkeyRegistrationOptions(user: {
  id: string;
  email: string;
  username: string;
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const existing = await prisma.userPasskey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });
  if (existing.length >= MAX_PASSKEYS) throw new AuthError("PASSKEY_LIMIT");
  const { rpID } = relyingParty();
  const options = await generateRegistrationOptions({
    rpName: PASSKEY_RP_NAME,
    rpID,
    userName: user.email,
    userDisplayName: user.username,
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    excludeCredentials: existing.map((passkey) => ({
      id: passkey.credentialId,
      transports: transportsOf(passkey.transports),
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
  });
  await prisma.authCeremony.deleteMany({ where: { userId: user.id, purpose: REGISTER } });
  await prisma.authCeremony.create({
    data: {
      userId: user.id,
      purpose: REGISTER,
      challenge: options.challenge,
      expiresAt: new Date(Date.now() + CEREMONY_TTL_MS),
    },
  });
  return options;
}

async function consumeRegistrationChallenge(userId: string): Promise<string | null> {
  const row = await prisma.authCeremony.findFirst({
    where: { userId, purpose: REGISTER },
    orderBy: { createdAt: "desc" },
  });
  if (!row) return null;
  const { count } = await prisma.authCeremony.deleteMany({ where: { id: row.id } });
  if (count !== 1 || row.expiresAt <= new Date()) return null;
  return row.challenge;
}

export async function registerPasskey(
  userId: string,
  name: string,
  rawResponse: unknown,
  ipAddress: string | null,
) {
  const parsed = registrationResponseSchema.safeParse(rawResponse);
  if (!parsed.success) throw passkeyFailed();
  const response = parsed.data as unknown as RegistrationResponseJSON;
  const expectedChallenge = await consumeRegistrationChallenge(userId);
  if (!expectedChallenge) throw passkeyChallengeExpired();
  const { rpID, origin } = relyingParty();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch {
    throw passkeyFailed();
  }
  if (!verification.verified) throw passkeyFailed();
  const { credential, credentialBackedUp } = verification.registrationInfo;
  if ((await prisma.userPasskey.count({ where: { userId } })) >= MAX_PASSKEYS) {
    throw new AuthError("PASSKEY_LIMIT");
  }
  const hash = credentialIdHash(credential.id);
  try {
    const updated = await prisma.user.update({
      where: { id: userId },
      data: {
        passkeys: {
          create: {
            credentialIdHash: hash,
            credentialId: credential.id,
            publicKey: Buffer.from(credential.publicKey),
            counter: BigInt(credential.counter),
            transports: credential.transports?.join(",").slice(0, 191) || null,
            backedUp: credentialBackedUp,
            name,
          },
        },
        securityEvents: { create: securityEvent(userActor(userId), "passkey.added", ipAddress) },
      },
      select: { passkeys: { where: { credentialIdHash: hash }, select: { id: true } } },
    });
    return { id: updated.passkeys[0]?.id ?? "" };
  } catch (error) {
    if (isPrismaCode(error, "P2002")) throw new AuthError("PASSKEY_EXISTS");
    throw error;
  }
}

export async function passkeyAuthenticationOptions(
  allow: { credentialId: string; transports: string | null }[] | null,
): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = relyingParty();
  return generateAuthenticationOptions({
    rpID,
    userVerification: allow ? "preferred" : "required",
    allowCredentials: (allow ?? []).map((passkey) => ({
      id: passkey.credentialId,
      transports: transportsOf(passkey.transports),
    })),
  });
}

export async function startPasswordlessCeremony(challenge: string) {
  const store = await cookies();
  const previous = store.get(PASSKEY_COOKIE)?.value;
  if (previous) await prisma.authCeremony.deleteMany({ where: { tokenHash: digest(previous) } });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + CEREMONY_TTL_MS);
  await prisma.authCeremony.create({
    data: { tokenHash: digest(token), purpose: LOGIN, challenge, expiresAt },
  });
  const opts = ceremonyCookieOptions(PASSKEY_COOKIE, expiresAt);
  store.set(opts.name, token, opts);
}

export async function consumePasswordlessCeremony(): Promise<string | null> {
  const store = await cookies();
  const token = store.get(PASSKEY_COOKIE)?.value;
  store.set({ ...ceremonyCookieOptions(PASSKEY_COOKIE, new Date(0)), value: "" });
  if (!token) return null;
  const row = await prisma.authCeremony.findUnique({ where: { tokenHash: digest(token) } });
  if (!row) return null;
  const { count } = await prisma.authCeremony.deleteMany({ where: { id: row.id } });
  if (count !== 1 || row.purpose !== LOGIN || row.expiresAt <= new Date()) return null;
  return row.challenge;
}

export async function verifyPasskeyAssertion(
  rawResponse: unknown,
  expectedChallenge: string,
  requireUserVerification: boolean,
  expectedUserId?: string,
): Promise<{ userId: string }> {
  const parsed = authenticationResponseSchema.safeParse(rawResponse);
  const response = parsed.success ? (parsed.data as unknown as AuthenticationResponseJSON) : null;
  const passkey = response
    ? await prisma.userPasskey.findUnique({
        where: { credentialIdHash: credentialIdHash(response.id) },
        select: {
          id: true,
          userId: true,
          credentialId: true,
          publicKey: true,
          counter: true,
          transports: true,
        },
      })
    : null;
  if (!response || !passkey || (expectedUserId && passkey.userId !== expectedUserId)) {
    if (expectedUserId) await guardSecondFactor(expectedUserId, async () => null, passkeyFailed);
    throw passkeyFailed();
  }
  const { rpID, origin } = relyingParty();
  await guardSecondFactor(
    passkey.userId,
    async () => {
      let verification;
      try {
        verification = await verifyAuthenticationResponse({
          response,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          requireUserVerification,
          credential: {
            id: passkey.credentialId,
            publicKey: new Uint8Array(passkey.publicKey),
            counter: Number(passkey.counter),
            transports: transportsOf(passkey.transports),
          },
        });
      } catch {
        return null;
      }
      if (!verification.verified) return null;
      const { count } = await prisma.userPasskey.updateMany({
        where: { id: passkey.id, counter: passkey.counter },
        data: {
          counter: BigInt(verification.authenticationInfo.newCounter),
          lastUsedAt: new Date(),
        },
      });
      return count === 1 ? true : null;
    },
    passkeyFailed,
  );
  return { userId: passkey.userId };
}
