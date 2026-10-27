import type { Instrumentation } from "next";

export async function register() {
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
    return;
  }
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  await import("./sentry.server.config");
  const { parseEnvironment } = await import("./lib/env");
  const environment = parseEnvironment();
  const { configureClientIp } = await import("./lib/http/client-ip");
  configureClientIp(environment.IP_MODE);
  const { ensureSystemCatalog } = await import("./lib/bootstrap/system-catalog");
  await ensureSystemCatalog();
  const { startWorker } = await import("./worker/boot");
  startWorker();
}

export const onRequestError: Instrumentation.onRequestError = async (
  error,
  request,
  context,
) => {
  const { reportRequestError } = await import("./lib/observability/request-error");
  await reportRequestError(error, request, context);
};
