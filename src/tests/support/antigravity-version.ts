import { ANTIGRAVITY_CLIENT_VERSION } from "@/lib/gateway/upstreams/antigravity-version";
import type { AntigravityVersionState } from "@/types/providers";

const holder = globalThis as typeof globalThis & { __llmhubAntigravityVersion?: AntigravityVersionState };

export function holdAntigravityVersion(version = ANTIGRAVITY_CLIENT_VERSION): void {
  holder.__llmhubAntigravityVersion = { version, nextCheckAt: Number.POSITIVE_INFINITY, pending: null, failing: false };
}

export function resetAntigravityVersion(): void {
  delete holder.__llmhubAntigravityVersion;
}

export function antigravityVersionState(): AntigravityVersionState | undefined {
  return holder.__llmhubAntigravityVersion;
}
