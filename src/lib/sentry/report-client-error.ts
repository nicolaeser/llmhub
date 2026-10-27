"use client";

import { publicSentryEnv, readSentryDsn } from "@/lib/sentry/options";

export function reportClientError(
  error: unknown,
  context?: Record<string, unknown>,
): void {
  if (!readSentryDsn(publicSentryEnv())) return;
  void import("@sentry/nextjs").then((Sentry) => {
    Sentry.captureException(error, context ? { extra: context } : undefined);
  });
}
