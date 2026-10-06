import { z } from "zod";

const inputTextSchema = z.looseObject({
  type: z.literal("input_text"),
  text: z.string(),
});

const inputImageSchema = z
  .looseObject({
    type: z.literal("input_image"),
    image_url: z.string().nullish(),
    file_id: z.string().nullish(),
    detail: z.enum(["low", "high", "auto"]).nullish(),
  })
  .refine((part) => Boolean(part.image_url), {
    path: ["image_url"],
    message: "input_image requires image_url or the file_id of a file uploaded to this gateway",
  });

const inputFileSchema = z
  .looseObject({
    type: z.literal("input_file"),
    file_data: z.string().nullish(),
    file_id: z.string().nullish(),
    filename: z.string().nullish(),
  })
  .refine((part) => Boolean(part.file_data), {
    path: ["file_data"],
    message: "input_file requires file_data or the file_id of a file uploaded to this gateway",
  });

const outputTextSchema = z.looseObject({
  type: z.literal("output_text"),
  text: z.string(),
});

const refusalSchema = z.looseObject({
  type: z.literal("refusal"),
  refusal: z.string(),
});

const contentPartSchema = z.discriminatedUnion("type", [
  inputTextSchema,
  inputImageSchema,
  inputFileSchema,
  outputTextSchema,
  refusalSchema,
]);

const messageItemSchema = z.looseObject({
  type: z.literal("message"),
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.looseObject({
  type: z.literal("function_call"),
  call_id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.string(),
});

const functionCallOutputItemSchema = z.looseObject({
  type: z.literal("function_call_output"),
  call_id: z.string().min(1),
  output: z.union([z.string(), z.array(contentPartSchema)]),
});

const reasoningItemSchema = z.looseObject({
  type: z.literal("reasoning"),
  encrypted_content: z.string().nullish(),
});

export const responsesInputItemSchema = z.preprocess(
  (value) =>
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === undefined &&
    "role" in value
      ? { ...value, type: "message" }
      : value,
  z.discriminatedUnion(
    "type",
    [messageItemSchema, functionCallItemSchema, functionCallOutputItemSchema, reasoningItemSchema],
    {
      error: (issue) =>
        issue.code === "invalid_union"
          ? "unsupported input item type; expected message, function_call, function_call_output, or reasoning"
          : undefined,
    },
  ),
);

const responsesToolSchema = z.discriminatedUnion(
  "type",
  [
    z.looseObject({
      type: z.literal("function"),
      name: z.string().min(1),
      description: z.string().nullish(),
      parameters: z.record(z.string(), z.unknown()).nullish(),
      strict: z.boolean().nullish(),
    }),
  ],
  {
    error: (issue) =>
      issue.code === "invalid_union"
        ? "unsupported tool type; only function tools are supported"
        : undefined,
  },
);

const toolChoiceSchema = z.union(
  [
    z.enum(["auto", "none", "required"]),
    z.looseObject({ type: z.literal("function"), name: z.string().min(1) }),
  ],
  { error: "tool_choice must be auto, none, required, or a function choice" },
);

const textFormatSchema = z.discriminatedUnion("type", [
  z.looseObject({ type: z.literal("text") }),
  z.looseObject({ type: z.literal("json_object") }),
  z.looseObject({
    type: z.literal("json_schema"),
    name: z.string().min(1),
    schema: z.record(z.string(), z.unknown()),
    description: z.string().nullish(),
    strict: z.boolean().nullish(),
  }),
]);

export const responsesRequestSchema = z
  .looseObject({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(responsesInputItemSchema)]).nullish(),
    instructions: z.string().nullish(),
    tools: z.array(responsesToolSchema).nullish(),
    tool_choice: toolChoiceSchema.nullish(),
    temperature: z.number().min(0).max(2).nullish(),
    top_p: z.number().min(0).max(1).nullish(),
    max_output_tokens: z.number().int().positive().nullish(),
    stream: z.boolean().nullish(),
    previous_response_id: z.string().min(1).nullish(),
    store: z.boolean().nullish(),
    metadata: z.record(z.string(), z.string()).nullish(),
    parallel_tool_calls: z.boolean().nullish(),
    user: z.string().nullish(),
    reasoning: z
      .looseObject({ effort: z.string().nullish(), summary: z.string().nullish() })
      .nullish(),
    text: z
      .looseObject({ format: textFormatSchema.nullish(), verbosity: z.string().nullish() })
      .nullish(),
    background: z.boolean().nullish(),
    service_tier: z.string().nullish(),
    include: z.array(z.string()).nullish(),
    prompt_cache_key: z.string().nullish(),
    safety_identifier: z.string().nullish(),
  })
  .refine((request) => request.background !== true, {
    path: ["background"],
    message: "background responses are not supported",
  })
  .refine(
    (request) =>
      Boolean(request.previous_response_id) ||
      (typeof request.input === "string" ? request.input.length > 0 : Boolean(request.input?.length)),
    { path: ["input"], message: "input is required" },
  );
