import "server-only";
import * as Sentry from "@sentry/nextjs";
import { env } from "@/lib/env";
import { sentryInitOptions } from "@/lib/sentry/options";

const options = sentryInitOptions(env);
if (options.dsn) {
  Sentry.init({
    ...options,
    tracePropagationTargets: [],
    integrations: [
      Sentry.httpIntegration({ disableIncomingRequestSpans: true, ignoreOutgoingRequests: () => true }),
      Sentry.nativeNodeFetchIntegration({ ignoreOutgoingRequests: () => true }),
    ],
  });
}
