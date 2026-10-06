import "server-only";
import type { Meta } from "@/types/logging";

function write(level: string, event: string, meta?: Meta) {
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

export const logger = {
  info(event: string, meta?: Meta) {
    write("info", event, meta);
  },
  warn(event: string, meta?: Meta) {
    write("warn", event, meta);
  },
  error(event: string, meta?: Meta) {
    write("error", event, meta);
  },
};
