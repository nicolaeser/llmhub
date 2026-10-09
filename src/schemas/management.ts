import { isIP } from "node:net";
import { z } from "zod";
import { KNOWN_BILLING_MODES, KNOWN_KINDS, KNOWN_STRATEGIES } from "@/lib/gateway/core";
import { clockMinute, isTimeZone, MAX_PRICE_WINDOWS } from "@/lib/gateway/price-schedule";
import { MANAGEMENT_PERMISSIONS } from "@/lib/management/scope";
import { accessWindowsSchema, allowedEndpointsSchema } from "@/schemas/keys";
import { budgetPeriod, MAX_BOOST_HOURS } from "@/lib/utils/budget";

const id = z.string().trim().min(1).max(64);
const alias = z.string().trim().min(1).max(200);
const optionalId = id.nullable().optional();
const money = z.number().min(0).max(1_000_000_000);
const rpm = z.number().int().min(0).max(1_000_000);
const tpm = z.number().int().min(0).max(1_000_000_000);
const ips = z
  .array(z.string().trim().refine((ip) => isIP(ip) !== 0, "invalid IP address"))
  .max(100);
const modelList = z.array(z.string().trim().min(1).max(200)).max(200);
const templateIds = z.array(id).max(50);
const strategy = z.string().refine((value) => KNOWN_STRATEGIES.has(value), "unknown routing strategy");
const billingMode = z.string().refine((value) => KNOWN_BILLING_MODES.has(value), "unknown billing mode");
const kind = z.string().refine((value) => KNOWN_KINDS.has(value), "unknown provider kind");
const url = z.string().trim().max(2000);
const clock = z.string().refine((value) => clockMinute(value) !== null, "expected HH:MM");
const timeZone = z.string().trim().max(64).refine(isTimeZone, "unknown IANA time zone");
const priceWindow = z
  .object({
    start: clock,
    end: clock,
    price_input_per_1k: money,
    price_output_per_1k: money,
  })
  .strict();

export const createManagementKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: z.array(z.enum(MANAGEMENT_PERMISSIONS)).min(1).max(MANAGEMENT_PERMISSIONS.length),
  days: z.number().int().min(0).max(365),
  code: z.string().trim().min(1).max(64),
});

export const apiKeyCreateSchema = z
  .object({
    alias: z.string().trim().min(1).max(80),
    project_id: optionalId,
    member_id: optionalId,
    models: modelList.default([]),
    template_ids: templateIds.default([]),
    rpm_limit: rpm.default(0),
    tpm_limit: tpm.default(0),
    allowed_ips: ips.default([]),
    allowed_endpoints: allowedEndpointsSchema.default([]),
    access_windows: accessWindowsSchema.default([]),
    access_time_zone: timeZone.default("UTC"),
    log_content: z.boolean().default(true),
    expires_in_days: z.number().int().min(0).max(3650).default(0),
  })
  .strict();

export const apiKeyUpdateSchema = z
  .object({
    alias: z.string().trim().min(1).max(80),
    project_id: optionalId,
    member_id: optionalId,
    models: modelList,
    template_ids: templateIds,
    rpm_limit: rpm,
    tpm_limit: tpm,
    allowed_ips: ips,
    allowed_endpoints: allowedEndpointsSchema,
    access_windows: accessWindowsSchema,
    access_time_zone: timeZone,
    log_content: z.boolean(),
    blocked: z.boolean(),
  })
  .partial()
  .strict();

const deploymentSchema = z
  .object({
    id: id.optional(),
    kind: kind.optional(),
    base_url: url.default(""),
    model: z.string().trim().min(1).max(200),
    weight: z.number().int().min(1).max(1000).default(1),
    cost_input_per_1k: money.default(0),
    cost_output_per_1k: money.default(0),
    provider_id: optionalId,
  })
  .strict();

const modelAliasFields = {
  enabled: z.boolean(),
  vendor: z.string().trim().max(60),
  display_name: z.string().trim().max(120),
  auto_routes: z.boolean().nullable(),
  strategy,
  billing_mode: billingMode,
  price_input_per_1k: money,
  price_output_per_1k: money,
  price_time_zone: timeZone,
  price_schedule: z.array(priceWindow).max(MAX_PRICE_WINDOWS),
  num_retries: z.number().int().min(0).max(10),
  overflow_group: z.string().trim().max(200),
  fallback_groups: z.array(alias).max(20),
  deployments: z.array(deploymentSchema).max(100),
};

export const modelAliasCreateSchema = z
  .object({
    alias,
    enabled: modelAliasFields.enabled.default(true),
    vendor: modelAliasFields.vendor.default(""),
    display_name: modelAliasFields.display_name.default(""),
    auto_routes: modelAliasFields.auto_routes.default(null),
    strategy: strategy.default("least_inflight"),
    billing_mode: billingMode.default("routed"),
    price_input_per_1k: money.default(0),
    price_output_per_1k: money.default(0),
    price_time_zone: timeZone.default("UTC"),
    price_schedule: modelAliasFields.price_schedule.default([]),
    num_retries: modelAliasFields.num_retries.default(0),
    overflow_group: modelAliasFields.overflow_group.default(""),
    fallback_groups: modelAliasFields.fallback_groups.default([]),
    deployments: modelAliasFields.deployments.default([]),
  })
  .strict();

export const modelAliasUpdateSchema = z.object(modelAliasFields).partial().strict();

export const providerCreateSchema = z
  .object({
    kind,
    name: z.string().trim().max(120).default(""),
    base_url: url.default(""),
    api_key: z.string().trim().max(4000).default(""),
  })
  .strict();

export const providerUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    base_url: url,
    api_key: z.string().trim().min(1).max(4000),
  })
  .partial()
  .strict();

export const providerImportSchema = z
  .object({
    models: modelList.default([]),
    strategy: strategy.default("cost_lowest"),
  })
  .strict();

export const teamCreateSchema = z
  .object({
    alias,
    org_id: id,
    rpm_limit: rpm.default(0),
    tpm_limit: tpm.default(0),
  })
  .strict();

export const teamUpdateSchema = z
  .object({ alias, rpm_limit: rpm, tpm_limit: tpm })
  .partial()
  .strict();

export const orgWriteSchema = z.object({ alias }).strict();

export const projectCreateSchema = z
  .object({
    alias,
    org_id: id,
    team_id: optionalId,
    owner: z.string().trim().max(200).default(""),
  })
  .strict();

export const projectUpdateSchema = z
  .object({ alias, team_id: optionalId, owner: z.string().trim().max(200) })
  .partial()
  .strict();

const memberEmail = z.string().trim().max(254).refine((value) => !value || value.includes("@"), "invalid email");

export const memberCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    org_id: id,
    team_id: optionalId,
    email: memberEmail.default(""),
    blocked: z.boolean().default(false),
    log_content: z.boolean().default(true),
  })
  .strict();

export const memberUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    team_id: optionalId,
    email: memberEmail,
    blocked: z.boolean(),
    log_content: z.boolean(),
  })
  .partial()
  .strict();

export const budgetEntitySchema = z.object({
  entity_type: z.enum(["key", "user", "member", "project", "team", "org"]),
  entity_id: id,
});

export const budgetUpdateSchema = z
  .object({
    max_budget: money,
    budget_duration: z
      .string()
      .trim()
      .max(20)
      .refine((value) => budgetPeriod(value) !== null, "use daily, weekly, monthly, or a day count like 30d")
      .optional(),
  })
  .strict();

export const temporaryBudgetSchema = z
  .object({
    amount: money,
    hours: z.number().int().min(1).max(MAX_BOOST_HOURS).default(24),
  })
  .strict();

export const budgetAlertsSchema = z
  .object({
    thresholds: z.array(z.number().min(1).max(100)).min(1).max(10),
  })
  .strict();

const queryText = z.string().trim().max(200).default("");

export const usageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(366).default(14),
  model: queryText,
  team_id: queryText,
  org_id: queryText,
  project_id: queryText,
  member_id: queryText,
  key_id: queryText,
  user_id: queryText,
});

export const logsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  page_size: z.coerce.number().int().min(10).max(100).default(50),
  model: queryText,
  endpoint: queryText,
  key_id: queryText,
  user_id: queryText,
  status: z.coerce.number().int().min(100).max(599).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});
