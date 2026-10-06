import "server-only";
import { envSchema } from "@/schemas/env";
import type { Env } from "@/types/env";

export function parseEnvironment(
  source: Record<string, string | undefined> = process.env,
): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}

let cached: Env | null = null;

function getEnv(): Env {
  if (!cached) cached = parseEnvironment();
  return cached;
}

export const env = new Proxy({} as Env, {
  get(_target, prop, receiver) {
    return Reflect.get(getEnv(), prop, receiver);
  },
});
