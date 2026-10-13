import "server-only";
import { writeLogLine } from "@/lib/logging/format";
import type { LogMeta } from "@/types/logging";

export const logger = {
  info(event: string, meta?: LogMeta) {
    writeLogLine("info", event, meta);
  },
  warn(event: string, meta?: LogMeta) {
    writeLogLine("warn", event, meta);
  },
  error(event: string, meta?: LogMeta) {
    writeLogLine("error", event, meta);
  },
};
