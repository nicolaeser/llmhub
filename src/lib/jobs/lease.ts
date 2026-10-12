import "server-only";

import prisma from "@/lib/db/prisma";
import { isPrismaCode } from "@/lib/auth/errors";

export async function claimLease(key: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const value = String(now + ttlMs);
  const claim = async () => {
    try {
      await prisma.setting.create({ data: { key, value } });
      return true;
    } catch (error) {
      if (isPrismaCode(error, "P2002")) return false;
      throw error;
    }
  };
  if (await claim()) return true;
  const expired = await prisma.setting.deleteMany({ where: { key, value: { lt: String(now) } } });
  return expired.count > 0 && (await claim());
}
