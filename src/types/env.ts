import type { envSchema } from "@/schemas/env";
import type { z } from "zod";

export type Env = z.infer<typeof envSchema>;
