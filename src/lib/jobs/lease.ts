import "server-only";

import prisma from "@/lib/db/prisma";

async function insertLeaseIfAbsent(key: string, value: string): Promise<boolean> {
  const { count } = await prisma.setting.createMany({ data: [{ key, value }], skipDuplicates: true });
  return count > 0;
}

export async function acquireLease(key: string, ttlMs: number, now = Date.now()): Promise<string | null> {
  const value = String(now + ttlMs);
  if (await insertLeaseIfAbsent(key, value)) return value;
  const expired = await prisma.setting.deleteMany({ where: { key, value: { lt: String(now) } } });
  return expired.count > 0 && (await insertLeaseIfAbsent(key, value)) ? value : null;
}

export async function claimLease(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  return (await acquireLease(key, ttlMs, now)) !== null;
}

export async function releaseLease(key: string, token: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key, value: token } });
}

export async function renewLease(key: string, token: string, ttlMs: number, now = Date.now()): Promise<string | null> {
  const value = String(now + ttlMs);
  if (value === token) return token;
  const renewed = await prisma.setting.updateMany({ where: { key, value: token }, data: { value } });
  return renewed.count > 0 ? value : null;
}
