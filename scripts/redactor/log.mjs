import process from "node:process";

export function log(level, event, fields = {}) {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields })}\n`);
}

export function errorCode(err) {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") return err.code;
  return err instanceof Error ? err.name : "Error";
}
