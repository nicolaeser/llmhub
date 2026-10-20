import { randomBytes } from "node:crypto";
import { NobleCryptoPlugin, ScureBase32Plugin, TOTP } from "otplib";
import prisma from "@/lib/db/prisma";
import { hashPassword } from "@/lib/auth/password";
import { newRecoveryCodes } from "@/lib/auth/recovery-codes";
import { newTotpSecret, sealTotpSecret } from "@/lib/auth/totp";

const generator = new TOTP({
  period: 30,
  digits: 6,
  algorithm: "sha1",
  crypto: new NobleCryptoPlugin(),
  base32: new ScureBase32Plugin(),
});

export function totpCode(secret: string, stepOffset = 0): Promise<string> {
  return generator.generate({ secret, epoch: Math.floor(Date.now() / 1000) + stepOffset * 30 });
}

export async function wrongTotpCode(secret: string): Promise<string> {
  const valid = new Set(await Promise.all([-1, 0, 1].map((offset) => totpCode(secret, offset))));
  let code = "000000";
  while (valid.has(code)) code = String(Math.floor(Math.random() * 1_000_000)).padStart(6, "0");
  return code;
}

export async function enrollTotp(userId: string) {
  const secret = newTotpSecret();
  const { codes, hashes } = newRecoveryCodes();
  await prisma.userTotp.create({
    data: {
      userId,
      secret: sealTotpSecret(userId, secret),
      enabledAt: new Date(),
      recoveryCodes: { createMany: { data: hashes.map((codeHash) => ({ codeHash })) } },
    },
  });
  return { secret, recoveryCodes: codes };
}

export async function givePassword(userId: string): Promise<string> {
  const password = `Pw-${randomBytes(10).toString("hex")}-7q`;
  await prisma.user.update({ where: { id: userId }, data: { password: await hashPassword(password) } });
  return password;
}

function addressGroup(): string {
  return (randomBytes(2).readUInt16BE() | 0x1000).toString(16);
}

export function documentationAddress(): string {
  return `2001:db8:${addressGroup()}:${addressGroup()}::${addressGroup()}`;
}

export function secondFactorFailures(userId: string): Promise<number> {
  return prisma.loginAttempt.count({ where: { key: `2fa:${userId}` } });
}
