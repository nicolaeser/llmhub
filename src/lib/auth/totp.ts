import "server-only";
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import QRCode from "qrcode";
import { AuthError } from "@/lib/auth/errors";
import { open, seal } from "@/lib/crypto";

const TOTP_ISSUER = "LLM Hub";
const TOTP_PERIOD_SECONDS = 30;

const totp = new TOTP({
  period: TOTP_PERIOD_SECONDS,
  digits: 6,
  algorithm: "sha1",
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

export function newTotpSecret(): string {
  return totp.generateSecret();
}

export function sealTotpSecret(userId: string, secret: string): string {
  return seal(`v1:${userId}:${secret}`);
}

export function openTotpSecret(userId: string, sealed: string): string {
  const prefix = `v1:${userId}:`;
  const value = open(sealed);
  if (!value.startsWith(prefix)) throw new AuthError("TWO_FACTOR_CHANGED");
  return value.slice(prefix.length);
}

export async function totpEnrollment(label: string, secret: string) {
  const uri = totp.toURI({ issuer: TOTP_ISSUER, label, secret });
  const qrDataUrl = await QRCode.toDataURL(uri, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 240,
  });
  return { secret, uri, qrDataUrl };
}

export async function matchTotp(
  secret: string,
  code: string,
  lastTimeStep: number | null,
  epoch?: number,
): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const result = await totp.verify(code, {
      secret,
      epochTolerance: TOTP_PERIOD_SECONDS,
      ...(lastTimeStep === null ? {} : { afterTimeStep: lastTimeStep }),
      ...(epoch === undefined ? {} : { epoch }),
    });
    return result.valid ? result.timeStep : null;
  } catch {
    return null;
  }
}
