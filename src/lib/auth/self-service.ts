import "server-only";
import { env } from "@/lib/env";
import { ssoOnlyActive } from "@/lib/auth/oidc";
import { getEnterprise } from "@/lib/settings/enterprise";

export async function registrationEnabled(): Promise<boolean> {
  const enterprise = await getEnterprise();
  return enterprise.registration_enabled === true && !ssoOnlyActive(enterprise.oidc);
}

export function passwordResetEnabled(): boolean {
  return Boolean(env.SMTP_URL);
}
