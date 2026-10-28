import process from "node:process";

export const PREDECESSOR_LOG_LINES = 200;

export function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export function errorMessage(err) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

export function replayLogText(text, write = (chunk) => process.stdout.write(chunk)) {
  const lines = String(text ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .slice(-PREDECESSOR_LOG_LINES);
  if (!lines.length) return 0;
  log("info", "updater.predecessor_logs", { count: lines.length });
  for (const line of lines) write(line.endsWith("\n") ? line : `${line}\n`);
  return lines.length;
}
