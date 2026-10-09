import { z } from "zod";

export const whatIfQuerySchema = z.object({
  model: z.string().trim().max(200).default(""),
});
