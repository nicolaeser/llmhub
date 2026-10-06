import { z } from "zod";

export const completionsRequestSchema = z.looseObject({
  model: z.string().min(1),
  prompt: z.union([z.string(), z.array(z.string()).min(1)], {
    error: "prompt must be a string or an array of strings; token prompts are not supported",
  }),
  max_tokens: z.number().int().min(0).nullish(),
  temperature: z.number().min(0).max(2).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  n: z.number().int().min(1).max(128).nullish(),
  stream: z.boolean().nullish(),
  stream_options: z.looseObject({ include_usage: z.boolean().nullish() }).nullish(),
  stop: z.union([z.string(), z.array(z.string()).max(4)]).nullish(),
  presence_penalty: z.number().min(-2).max(2).nullish(),
  frequency_penalty: z.number().min(-2).max(2).nullish(),
  logit_bias: z.record(z.string(), z.number()).nullish(),
  user: z.string().nullish(),
  seed: z.number().int().nullish(),
  echo: z.boolean().nullish(),
  suffix: z.string().nullish(),
  logprobs: z.number().int().nullish(),
  best_of: z.number().int().nullish(),
});
