import type { LogLevel, Meta } from "@/types/logging";

const MAX_ERROR_TEXT = 300;

export function writeLogLine(level: LogLevel, event: string, meta?: Meta): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...meta,
  });
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function errorFields(err: unknown): Meta {
  const text = err instanceof Error ? err.message : String(err);
  const summary = text.split("\n").map((part) => part.trim()).find(Boolean) ?? "";
  const code = err !== null && typeof err === "object" ? (err as { code?: unknown }).code : undefined;
  return {
    errName: err instanceof Error ? err.name : typeof err,
    err: summary.slice(0, MAX_ERROR_TEXT),
    ...(typeof code === "string" ? { errCode: code } : {}),
  };
}
