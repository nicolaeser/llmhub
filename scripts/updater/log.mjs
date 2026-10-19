import process from "node:process";

export function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export function errorMessage(err) {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
