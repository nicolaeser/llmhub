import "server-only";
import { writeLogLine } from "@/lib/logging/format";
import type { Meta } from "@/types/logging";

export const logger = {
  info(event: string, meta?: Meta) {
    writeLogLine("info", event, meta);
  },
  warn(event: string, meta?: Meta) {
    writeLogLine("warn", event, meta);
  },
  error(event: string, meta?: Meta) {
    writeLogLine("error", event, meta);
  },
};
