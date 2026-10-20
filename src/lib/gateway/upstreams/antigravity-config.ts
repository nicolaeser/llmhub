import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";
import type { AntigravityClientState } from "@/types/providers";

export const BUNDLED_CLIENT_SECRET_FILE = "antigravity-client-secret";

let bundledSecret: Promise<string> | null = null;

export async function readBundledClientSecret(file: string): Promise<string> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch (err) {
    const missing = (err as { code?: unknown }).code === "ENOENT";
    if (!missing) logger.warn("antigravity.bundled_secret_unreadable", errorFields(err));
    return "";
  }
}

function bundledClientSecret(): Promise<string> {
  bundledSecret ??= readBundledClientSecret(path.join(process.cwd(), BUNDLED_CLIENT_SECRET_FILE));
  return bundledSecret;
}

async function savedClientSecret(): Promise<string> {
  return (await getEnterprise()).antigravity?.client_secret ?? "";
}

export async function antigravityClientSecret(): Promise<string> {
  return (await savedClientSecret()) || (await bundledClientSecret());
}

export async function antigravityClientState(): Promise<AntigravityClientState> {
  const [saved, bundled] = await Promise.all([savedClientSecret(), bundledClientSecret()]);
  return { saved: saved !== "", bundled: bundled !== "" };
}

export async function saveAntigravityClientSecret(clientSecret: string): Promise<void> {
  await patchEnterprise({ antigravity: { client_secret: clientSecret } });
}
