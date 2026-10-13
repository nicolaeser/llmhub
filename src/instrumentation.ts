export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { parseEnvironment } = await import("./lib/env");
  parseEnvironment();
  const { ensureSystemCatalog } = await import("./lib/bootstrap/system-catalog");
  await ensureSystemCatalog();
  const { startWorker } = await import("./worker/boot");
  startWorker();
}
