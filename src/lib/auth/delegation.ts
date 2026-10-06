import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthenticatedSession } from "@/types/auth";

const delegated = new AsyncLocalStorage<AuthenticatedSession>();

export function runAsPrincipal<T>(principal: AuthenticatedSession, fn: () => Promise<T>): Promise<T> {
  return delegated.run(principal, fn);
}

export function delegatedPrincipal(): AuthenticatedSession | undefined {
  return delegated.getStore();
}
