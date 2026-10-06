import { z } from "zod";

const freeform = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const noulQuestionSchema = z.looseObject({
  type: z.literal("noul"),
  instructions: freeform.nullish(),
  criteria: z.looseObject({ true: freeform.nullish(), false: freeform.nullish() }).nullish(),
});

const choiceQuestionSchema = z.looseObject({
  type: z.literal("choice"),
  instructions: freeform.nullish(),
  criteria: z
    .record(z.string(), freeform.nullable())
    .refine((criteria) => Object.keys(criteria).length > 0, "choice criteria need at least one option"),
});

const scoreQuestionSchema = z.looseObject({
  type: z.literal("score"),
  instructions: freeform.nullish(),
  criteria: z.array(freeform).min(1),
});

export const systemOneQuestionSchema = z.discriminatedUnion(
  "type",
  [noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema],
  {
    error: (issue) =>
      issue.code === "invalid_union" ? "question type must be noul, choice, or score" : undefined,
  },
);

export const systemOneRequestSchema = z.looseObject({
  model: z.string().min(1),
  state: freeform,
  questions: z
    .record(z.string(), systemOneQuestionSchema)
    .refine((questions) => Object.keys(questions).length > 0, "questions need at least one entry"),
});
