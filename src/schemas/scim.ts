import { z } from "zod";

const SCIM_PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

const scimTextSchema = z.string().trim().max(191);

export const scimBooleanSchema = z.union([
  z.boolean(),
  z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.enum(["true", "false"]))
    .transform((value) => value === "true"),
]);

const scimMultiValueSchema = z.object({
  value: scimTextSchema.optional(),
  primary: scimBooleanSchema.optional(),
});

export const scimValuesSchema = z
  .union([
    scimTextSchema.transform((value) => [{ value, primary: false }]),
    scimMultiValueSchema.transform((item) => [item]),
    z
      .array(
        z.union([
          scimTextSchema.transform((value) => ({ value, primary: false })),
          scimMultiValueSchema,
        ]),
      )
      .max(50),
  ])
  .transform((items) =>
    items
      .flatMap((item) => (item.value ? [{ value: item.value, primary: item.primary === true }] : []))
      .sort((a, b) => Number(b.primary) - Number(a.primary)),
  );

export const scimUserNameSchema = z.string().trim().min(1).max(191);

export const scimEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(191)
  .refine((value) => value.includes("@"));

export const scimUserResourceSchema = z.object({
  userName: scimTextSchema.nullish(),
  emails: scimValuesSchema.nullish(),
  roles: scimValuesSchema.nullish(),
  active: scimBooleanSchema.nullish(),
});

export const scimPatchSchema = z.object({
  schemas: z.array(z.string()).refine((schemas) => schemas.includes(SCIM_PATCH_OP_SCHEMA)),
  Operations: z
    .array(
      z.object({
        op: z.string().trim().toLowerCase().pipe(z.enum(["add", "replace", "remove"])),
        path: z.string().trim().max(512).optional(),
        value: z.unknown().optional(),
      }),
    )
    .min(1)
    .max(100),
});
