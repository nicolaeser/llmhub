export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { parseEnvironment } = await import("./lib/env");
  const environment = parseEnvironment();
  const { configureClientIp } = await import("./lib/http/client-ip");
  configureClientIp(environment.IP_MODE);
  const { ensureSystemCatalog } = await import("./lib/bootstrap/system-catalog");
  await ensureSystemCatalog();
  const { startWorker } = await import("./worker/boot");
  startWorker();
}
