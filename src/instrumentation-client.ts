import { publicSentryEnv, sentryInitOptions } from "@/lib/sentry/options";

const options = sentryInitOptions(publicSentryEnv());
const sentry = options.dsn
  ? import("@sentry/nextjs").then((Sentry) => {
      Sentry.init(options);
      return Sentry;
    })
  : undefined;

export function onRouterTransitionStart(
  url: string,
  navigationType: "push" | "replace" | "traverse",
): void {
  void sentry?.then((Sentry) => Sentry.captureRouterTransitionStart(url, navigationType));
}
