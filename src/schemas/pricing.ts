import { z } from "zod";
import {
  MARKUP_SCOPES,
  MAX_MARKUP_PERCENT,
  MIN_MARKUP_PERCENT,
  markupModel,
} from "@/lib/gateway/markup-policy";

export const markupSchema = z
  .object({
    id: z.string().trim().max(64).default(""),
    scope: z.enum(MARKUP_SCOPES),
    targetId: z.string().trim().max(64).default(""),
    model: z.string().max(200).default("").transform(markupModel),
    percent: z.number().finite().min(MIN_MARKUP_PERCENT).max(MAX_MARKUP_PERCENT),
    note: z.string().trim().max(200).default(""),
  })
  .refine((input) => (input.scope === "all") === !input.targetId, { path: ["targetId"] })
  .transform((input) => ({ ...input, percent: Math.round(input.percent * 10_000) / 10_000 }));
