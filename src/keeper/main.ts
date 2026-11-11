import { heartbeatFresh } from "./heartbeat";

if (process.argv.includes("--healthcheck")) {
  process.exitCode = (await heartbeatFresh()) ? 0 : 1;
} else {
  const { runKeeper } = await import("./run");
  await runKeeper();
}
