import { scrubEvent } from "@/lib/sentry/scrub";
import type { SentryEnv, SentryInitOptions } from "@/types/sentry";

const DSN_KEYS = ["SENTRY_DSN", "NEXT_PUBLIC_SENTRY_DSN"] as const;
const PUBLIC_DSN_KEYS = ["NEXT_PUBLIC_SENTRY_DSN"] as const;

export function publicSentryEnv(): SentryEnv {
  return {
    NEXT_PUBLIC_SENTRY_DSN: process.env.NEXT_PUBLIC_SENTRY_DSN,
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
    NEXT_PUBLIC_SENTRY_RELEASE: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE,
    NODE_ENV: process.env.NODE_ENV,
  };
}

export function readSentryDsn(
  source: SentryEnv,
  keys: readonly string[] = DSN_KEYS,
): string | undefined {
  for (const key of keys) {
    const value = source[key]?.trim();
    if (value) return value;
  }
  return undefined;
}

export function sentryIngestOrigin(source: SentryEnv): string | undefined {
  const dsn = readSentryDsn(source, PUBLIC_DSN_KEYS);
  return dsn && URL.canParse(dsn) ? new URL(dsn).origin : undefined;
}

function tracesSampleRate(source: SentryEnv): number {
  const raw =
    source.SENTRY_TRACES_SAMPLE_RATE ?? source.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE;
  if (!raw?.trim()) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

const HEADER_DENYLIST = {
  deny: ["authorization", "cookie", "set-cookie", "forwarded", "-ip", "remote-", "via", "-user", "-peer-"],
};

export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: HEADER_DENYLIST, response: HEADER_DENYLIST },
  httpBodies: [] as never[],
  urlQueryParams: false,
  genAI: { inputs: false, outputs: false },
  graphQL: { document: false, variables: false },
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  frameContextLines: 7,
};

export function sentryInitOptions(source: SentryEnv): SentryInitOptions {
  const dsn = readSentryDsn(source);
  return {
    dsn,
    enabled: Boolean(dsn),
    environment:
      source.SENTRY_ENVIRONMENT?.trim() ||
      source.NEXT_PUBLIC_SENTRY_ENVIRONMENT?.trim() ||
      (source.NODE_ENV === "development" ? "development" : "production"),
    release:
      source.SENTRY_RELEASE?.trim() ||
      source.NEXT_PUBLIC_SENTRY_RELEASE?.trim() ||
      source.BUILD_ID?.trim() ||
      undefined,
    tracesSampleRate: tracesSampleRate(source),
    dataCollection: SENTRY_DATA_COLLECTION,
    beforeSend: scrubEvent,
    beforeSendSpan: scrubEvent,
  };
}
