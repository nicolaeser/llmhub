import "server-only";
import { env } from "@/lib/env";
import { getEnterprise } from "@/lib/gateway/settings";

export async function registrationEnabled(): Promise<boolean> {
  return (await getEnterprise()).registration_enabled === true;
}

export function passwordResetEnabled(): boolean {
  return Boolean(env.SMTP_URL);
}
