import { accessWindowValid } from "@/lib/gateway/access/key-restrictions";
import type { TemplateOption } from "@/types/model-templates";
import type {
  KeyAccessSummary,
  KeyBindingKind,
  KeyDraft,
  KeyFieldsInput,
  KeyPreset,
  VirtualKeyView,
} from "@/types/keys";

export const KEY_EXPIRY_DAYS = [0, 30, 90, 365] as const;

const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6 = /^[0-9a-f:.]+$/i;

export function splitList(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function looksLikeIp(value: string): boolean {
  if (IPV4.test(value)) return true;
  return value.includes(":") && IPV6.test(value) && (value.match(/::/g) ?? []).length <= 1;
}

export function invalidIps(value: string): string[] {
  return splitList(value).filter((entry) => !looksLikeIp(entry));
}

export function newKeyDraft(kind: KeyBindingKind, preset: KeyPreset | null): KeyDraft {
  return {
    alias: "",
    kind,
    projectId: preset?.kind === "project" ? preset.id : "",
    memberId: preset?.kind === "member" ? preset.id : "",
    restricted: false,
    models: [],
    templateIds: [],
    rpm: 0,
    tpm: 0,
    maxRequestCost: 0,
    days: 0,
    budget: 0,
    budgetPeriod: "30d",
    ips: "",
    endpoints: [],
    windows: [],
    timeZone: "UTC",
    logContent: true,
    blocked: false,
  };
}

export function draftOfKey(key: VirtualKeyView): KeyDraft {
  return {
    alias: key.key_alias,
    kind: key.member_id ? "member" : key.project_id ? "project" : "internal",
    projectId: key.project_id,
    memberId: key.member_id,
    restricted: key.models.length > 0 || key.templates.length > 0,
    models: key.models,
    templateIds: key.templates,
    rpm: key.rpm_limit,
    tpm: key.tpm_limit,
    maxRequestCost: key.max_request_cost,
    days: 0,
    budget: key.max_budget,
    budgetPeriod: key.budget_duration,
    ips: key.allowed_ips.join("\n"),
    endpoints: key.allowed_endpoints,
    windows: key.access_windows.map((window, index) => ({ ...window, key: index + 1 })),
    timeZone: key.access_time_zone,
    logContent: key.log_content,
    blocked: key.blocked,
  };
}

export function keyFieldsOf(draft: KeyDraft): KeyFieldsInput {
  return {
    alias: draft.alias.trim(),
    projectId: draft.kind === "project" ? draft.projectId : "",
    memberId: draft.kind === "member" ? draft.memberId : "",
    models: draft.restricted ? draft.models : [],
    templateIds: draft.restricted ? draft.templateIds : [],
    rpm: wholeLimit(draft.rpm),
    tpm: wholeLimit(draft.tpm),
    maxRequestCost: Number.isFinite(draft.maxRequestCost) && draft.maxRequestCost > 0 ? draft.maxRequestCost : 0,
    allowedIps: splitList(draft.ips),
    allowedEndpoints: draft.endpoints,
    accessWindows: draft.windows.map(({ days, start, end }) => ({ days, start, end })),
    accessTimeZone: draft.timeZone,
    logContent: draft.logContent,
  };
}

function wholeLimit(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function draftBound(draft: Pick<KeyDraft, "kind" | "projectId" | "memberId">): boolean {
  if (draft.kind === "project") return Boolean(draft.projectId);
  if (draft.kind === "member") return Boolean(draft.memberId);
  return true;
}

export function draftBasicsValid(draft: KeyDraft): boolean {
  return draft.alias.trim().length > 0 && draftBound(draft);
}

export function draftAccessValid(draft: KeyDraft): boolean {
  return !draft.restricted || draft.models.length > 0 || draft.templateIds.length > 0;
}

export function draftNetworkValid(draft: KeyDraft): boolean {
  return invalidIps(draft.ips).length === 0;
}

export function draftScheduleValid(draft: KeyDraft): boolean {
  return draft.windows.every(accessWindowValid);
}

export function accessSummary(
  access: { restricted?: boolean; models: string[]; templateIds: string[] },
  templates: readonly Pick<TemplateOption, "id" | "matches">[],
): KeyAccessSummary {
  const restricted = access.restricted ?? (access.models.length > 0 || access.templateIds.length > 0);
  if (!restricted || (!access.models.length && !access.templateIds.length)) return { state: "all", models: [] };
  const models = [
    ...new Set([
      ...templates.filter((template) => access.templateIds.includes(template.id)).flatMap((template) => template.matches),
      ...access.models,
    ]),
  ].sort((a, b) => a.localeCompare(b));
  return { state: models.length ? "some" : "none", models };
}
