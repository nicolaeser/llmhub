"use server";

import { registrationEnabled } from "@/lib/auth/self-service";
import { runAction } from "@/lib/http/action-result";

export async function registrationContextAction() {
  return runAction(async () => ({ enabled: await registrationEnabled() }));
}
