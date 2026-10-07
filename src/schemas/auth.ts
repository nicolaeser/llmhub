import { z } from "zod";
import { passwordPolicyIssue, PASSWORD_MAX_LENGTH } from "@/lib/auth/password-policy";
import { permissions, roleTemplateKeys } from "@/lib/auth/permissions";
import { assistantToolNames } from "@/lib/assistant/catalog";
import type { Permission } from "@/types/auth";

export const idSchema = z.string().min(1).max(191);

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(191)
  .refine((value) => value.includes("@"));

const usernameSchema = z.string().trim().min(2).max(40);

const passwordInputSchema = z.string().min(1).max(256);

export const newPasswordSchema = z
  .string()
  .max(PASSWORD_MAX_LENGTH)
  .superRefine((value, ctx) => {
    const issue = passwordPolicyIssue(value);
    if (issue) ctx.addIssue({ code: "custom", message: issue });
  });

const stepUpCodeSchema = z.string().trim().min(1).max(64);

function rejectPersonalPassword(
  value: { password: string; email: string; username: string },
  ctx: z.RefinementCtx,
) {
  const issue = passwordPolicyIssue(value.password, [value.email, value.username]);
  if (issue) ctx.addIssue({ code: "custom", path: ["password"], message: issue });
}

export const passwordSignInSchema = z
  .object({ email: emailSchema, password: passwordInputSchema })
  .strict();

export const totpCodeSchema = z
  .object({ code: z.string().trim().regex(/^\d{6}$/) })
  .strict();

export const secondFactorProofSchema = z
  .object({
    method: z.enum(["totp", "recovery"]),
    code: z.string().trim().min(1).max(32),
  })
  .strict();

export const stepUpSchema = z.object({ code: stepUpCodeSchema }).strict();

export const requiredPasswordChangeSchema = z
  .object({ password: newPasswordSchema })
  .strict();

export const changePasswordSchema = z
  .object({ currentPassword: passwordInputSchema, newPassword: newPasswordSchema })
  .strict();

const passkeyNameSchema = z.string().trim().min(1).max(64);

export const passkeyAssertionSchema = z.object({ response: z.unknown() }).strict();

export const passkeyFinishSchema = z
  .object({ name: passkeyNameSchema, response: z.unknown() })
  .strict();

export const passkeyRenameSchema = z
  .object({ id: idSchema, name: passkeyNameSchema })
  .strict();

export const passkeyRemoveSchema = z
  .object({ id: idSchema, code: stepUpCodeSchema })
  .strict();

export const sessionRevokeSchema = z.object({ id: idSchema }).strict();

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/).max(4096);

export const registrationResponseSchema = z.looseObject({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64url,
    attestationObject: z.string().regex(/^[A-Za-z0-9_-]+$/).max(65536),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(40).optional(),
});

export const authenticationResponseSchema = z.looseObject({
  id: base64url,
  rawId: base64url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: base64url,
    authenticatorData: base64url,
    signature: base64url,
    userHandle: base64url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()).default({}),
  authenticatorAttachment: z.string().max(40).optional(),
});

export const setupSchema = z
  .object({ username: usernameSchema, email: emailSchema, password: newPasswordSchema })
  .strict()
  .superRefine(rejectPersonalPassword);

export const registerSchema = z
  .object({ username: usernameSchema, email: emailSchema, password: newPasswordSchema })
  .strict()
  .superRefine(rejectPersonalPassword);

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();

export const resetPasswordSchema = z
  .object({ token: z.string().min(16).max(256), password: newPasswordSchema })
  .strict();

const permissionSchema = z.enum(permissions as [Permission, ...Permission[]]);

export const roleWriteSchema = z
  .object({
    name: z.string().trim().min(2).max(80).nullable(),
    description: z.string().trim().max(500).nullable(),
    permissions: z.array(permissionSchema).max(permissions.length),
    assistantToolsDisabled: z.array(z.enum(assistantToolNames)).max(assistantToolNames.length).default([]),
  })
  .strict();

export const roleUpdateSchema = roleWriteSchema
  .extend({ revision: z.number().int().min(0) })
  .strict();

export const roleRevisionSchema = z.number().int().min(0);

export const roleTemplateKeySchema = z.enum(roleTemplateKeys);

export const userCreateSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema,
    password: newPasswordSchema,
    roleId: idSchema,
    orgId: z.string().max(191).optional(),
  })
  .strict()
  .superRefine(rejectPersonalPassword);

export const userAccessSchema = z
  .object({
    userId: idSchema,
    roleId: idSchema,
    orgId: z.string().max(191),
    revision: z.number().int().min(0),
  })
  .strict();

export const userPasswordSchema = z
  .object({
    userId: idSchema,
    password: newPasswordSchema,
    requireChange: z.boolean(),
    code: stepUpCodeSchema,
  })
  .strict();

export const userSecurityResetSchema = z
  .object({ userId: idSchema, code: stepUpCodeSchema })
  .strict();
