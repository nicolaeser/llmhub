import "server-only";
import { getEnterprise, patchEnterprise } from "@/lib/settings/enterprise";

export async function antigravityClientSecret(): Promise<string> {
  return (await getEnterprise()).antigravity?.client_secret ?? "";
}

export async function saveAntigravityClientSecret(clientSecret: string): Promise<void> {
  await patchEnterprise({ antigravity: { client_secret: clientSecret } });
}
