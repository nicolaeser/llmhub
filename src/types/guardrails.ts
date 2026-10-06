import type { z } from "zod";
import type { piiOverrideSchema } from "@/schemas/guardrails";

export type PiiMode = "mask" | "block";

export type PiiScope = "org" | "key";

export type PiiPolicy = {
  enabled: boolean;
  mode: PiiMode;
  output: boolean;
  entities: string[];
};

export type PiiOverrideInput = z.infer<typeof piiOverrideSchema>;

export type PiiTarget = {
  scope: PiiScope;
  id: string;
  alias: string;
  orgId: string;
};

export type PiiOverrideView = PiiTarget & { policy: PiiPolicy };
