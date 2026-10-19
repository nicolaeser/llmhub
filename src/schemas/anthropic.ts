import { z } from "zod";

const cacheControlSchema = z.looseObject({ type: z.string() });

const textBlockSchema = z.looseObject({
  type: z.literal("text"),
  text: z.string(),
  cache_control: cacheControlSchema.nullish(),
});

const base64SourceSchema = z.looseObject({
  type: z.literal("base64"),
  media_type: z.string().min(1),
  data: z.string().min(1),
});

const urlSourceSchema = z.looseObject({
  type: z.literal("url"),
  url: z.string().min(1),
});

const textSourceSchema = z.looseObject({
  type: z.literal("text"),
  media_type: z.string().nullish(),
  data: z.string(),
});

const fileSourceSchema = z.looseObject({
  type: z.literal("file"),
  file_id: z.string().min(1),
});

const contentSourceSchema = z.looseObject({
  type: z.literal("content"),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]),
});

const imageBlockSchema = z.looseObject({
  type: z.literal("image"),
  source: z.discriminatedUnion("type", [base64SourceSchema, urlSourceSchema, fileSourceSchema]),
  cache_control: cacheControlSchema.nullish(),
});

const documentBlockSchema = z.looseObject({
  type: z.literal("document"),
  source: z.discriminatedUnion("type", [
    base64SourceSchema,
    textSourceSchema,
    urlSourceSchema,
    fileSourceSchema,
    contentSourceSchema,
  ]),
  title: z.string().nullish(),
  cache_control: cacheControlSchema.nullish(),
});

export const VALIDATED_BLOCK_TYPES: ReadonlySet<string> = new Set([
  "text",
  "image",
  "document",
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
]);

const passthroughBlockSchema = z.looseObject({
  type: z
    .string()
    .min(1)
    .refine((type) => !VALIDATED_BLOCK_TYPES.has(type), { abort: true }),
});

const toolUseBlockSchema = z.looseObject({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown().optional(),
});

const toolResultBlockSchema = z.looseObject({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z
    .union([
      z.string(),
      z.array(
        z.union([
          z.discriminatedUnion("type", [textBlockSchema, imageBlockSchema, documentBlockSchema]),
          passthroughBlockSchema,
        ]),
      ),
    ])
    .optional(),
  is_error: z.boolean().nullish(),
});

const thinkingBlockSchema = z.looseObject({
  type: z.literal("thinking"),
  thinking: z.string(),
  signature: z.string().nullish(),
});

const redactedThinkingBlockSchema = z.looseObject({
  type: z.literal("redacted_thinking"),
  data: z.string(),
});

export const messagesContentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  imageBlockSchema,
  documentBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
]);

export const messagesRequestBlockSchema = z.union([messagesContentBlockSchema, passthroughBlockSchema]);

const messageSchema = z.looseObject({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(messagesRequestBlockSchema)]),
});

export const messagesToolSchema = z
  .looseObject({
    type: z.string().nullish(),
    name: z.string().nullish(),
    description: z.string().nullish(),
    input_schema: z.record(z.string(), z.unknown()).nullish(),
    strict: z.boolean().nullish(),
  })
  .superRefine((tool, ctx) => {
    if ((!tool.type || tool.type === "custom") && !tool.name) {
      ctx.addIssue({ code: "custom", path: ["name"], message: "custom tools require a name" });
    }
  });

const thinkingConfigSchema = z.looseObject({
  type: z.string().min(1),
  budget_tokens: z.number().int().nullish(),
  display: z.string().nullish(),
});

const outputConfigSchema = z.looseObject({
  effort: z.string().nullish(),
  format: z
    .looseObject({ type: z.string().min(1), schema: z.record(z.string(), z.unknown()).nullish() })
    .nullish(),
});

const toolChoiceSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("auto"), disable_parallel_tool_use: z.boolean().nullish() }),
  z.looseObject({ type: z.literal("any"), disable_parallel_tool_use: z.boolean().nullish() }),
  z.looseObject({
    type: z.literal("tool"),
    name: z.string().min(1),
    disable_parallel_tool_use: z.boolean().nullish(),
  }),
  z.looseObject({ type: z.literal("none") }),
]);

export const messagesRequestSchema = z.looseObject({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  system: z.union([z.string(), z.array(textBlockSchema)]).nullish(),
  max_tokens: z.number().int().min(0).nullish(),
  temperature: z.number().min(0).max(1).nullish(),
  top_p: z.number().min(0).max(1).nullish(),
  top_k: z.number().int().min(0).nullish(),
  stop_sequences: z.array(z.string()).nullish(),
  stream: z.boolean().nullish(),
  metadata: z.looseObject({ user_id: z.string().nullish() }).nullish(),
  tools: z.array(messagesToolSchema).nullish(),
  tool_choice: toolChoiceSchema.nullish(),
  service_tier: z.string().nullish(),
  speed: z.string().nullish(),
  thinking: thinkingConfigSchema.nullish(),
  output_config: outputConfigSchema.nullish(),
});
