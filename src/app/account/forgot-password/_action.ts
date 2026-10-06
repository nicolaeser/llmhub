"use server";

import { passwordResetEnabled } from "@/lib/auth/self-service";
import { runAction } from "@/lib/http/action-result";

export async function passwordResetContextAction() {
  return runAction(async () => ({ enabled: passwordResetEnabled() }));
}
