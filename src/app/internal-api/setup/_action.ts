"use server";

import { createFirstAdmin } from "@/lib/bootstrap/first-admin";
import type { CreateFirstAdminResult } from "@/types/setup";

export async function createFirstAdminAction(input: unknown): Promise<CreateFirstAdminResult> {
  return createFirstAdmin(input);
}
