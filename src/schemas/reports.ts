import { z } from "zod";
import { routing } from "@/i18n/routing";
import { MAX_REPORT_RECIPIENTS, REPORT_CADENCES, REPORT_FORMATS } from "@/lib/reports/period";

export const reportRecipientSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .regex(/^[^\s@<>,;"()[\]\\]+@[^\s@<>,;"()[\]\\]+$/);

export const usageReportSchema = z.object({
  id: z.string().trim().max(64).optional(),
  orgId: z.string().trim().min(1).max(64),
  teamId: z.string().trim().max(64).default(""),
  cadence: z.enum(REPORT_CADENCES),
  format: z.enum(REPORT_FORMATS),
  locale: z.enum(routing.locales),
  recipients: z
    .array(reportRecipientSchema)
    .max(MAX_REPORT_RECIPIENTS)
    .transform((list) => [...new Set(list)]),
  enabled: z.boolean().default(true),
});
