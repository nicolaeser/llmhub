import { readFileSync } from "node:fs";

export const LEGACY_MIGRATIONS = JSON.parse(
  readFileSync(new URL("./legacy-migrations.json", import.meta.url), "utf8"),
) as Record<string, string>;

export const COMPATIBILITY_MIGRATION = "20261115145000_prisma_compatibility";
export const CONTENT_SIZE_MIGRATION = "20261115145340_request_content_size";
