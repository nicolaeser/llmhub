import type { Instrumentation } from "next";

export const reportRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const Sentry = await import("@sentry/nextjs");
  await Sentry.captureRequestError(error, request, context);
};
