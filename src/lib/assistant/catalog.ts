import type {
  AssistantToolAccess,
  AssistantToolGate,
  AssistantToolGroup,
  AssistantToolMeta,
  AssistantToolName,
  AssistantToolView,
} from "@/types/assistant";
import type { Permission } from "@/types/auth";

const meta = (
  group: AssistantToolGroup,
  access: AssistantToolAccess,
  permission: Permission | null,
): AssistantToolMeta => ({ group, access, permission });

export const assistantToolCatalog = {
  get_setup_status: meta("general", "read", null),
  whoami: meta("general", "read", null),
  explain: meta("general", "read", null),
  open_page: meta("general", "read", null),
  list_provider_kinds: meta("general", "read", null),
  list_api_endpoints: meta("general", "read", null),
  code_example: meta("general", "read", null),
  get_overview: meta("usage", "read", "spend:read"),
  get_usage: meta("usage", "read", "spend:read"),
  search_logs: meta("usage", "read", "spend:read"),
  usage_breakdown: meta("usage", "read", "spend:read"),
  search_audit_log: meta("usage", "read", "spend:read-all"),
  get_log: meta("usage", "read", "spend:read"),
  list_providers: meta("providers", "read", "providers:read"),
  get_provider: meta("providers", "read", "providers:read"),
  create_provider: meta("providers", "write", "providers:manage"),
  update_provider: meta("providers", "write", "providers:manage"),
  refresh_provider_models: meta("providers", "write", "providers:manage"),
  import_provider_models: meta("providers", "write", "providers:manage"),
  delete_provider: meta("providers", "destructive", "providers:manage"),
  list_models: meta("models", "read", "models:read"),
  get_model: meta("models", "read", "models:read"),
  create_model: meta("models", "write", "models:manage"),
  update_model: meta("models", "write", "models:manage"),
  delete_model: meta("models", "destructive", "models:manage"),
  list_model_templates: meta("models", "read", "models:read"),
  save_model_template: meta("models", "write", "models:manage"),
  delete_model_template: meta("models", "destructive", "models:manage"),
  list_keys: meta("keys", "read", "keys:read"),
  get_key: meta("keys", "read", "keys:read"),
  create_key: meta("keys", "write", "keys:manage"),
  update_key: meta("keys", "write", "keys:manage"),
  rotate_key: meta("keys", "destructive", "keys:manage"),
  revoke_key: meta("keys", "destructive", "keys:manage"),
  get_structure: meta("structure", "read", "tenancy:read"),
  save_structure_node: meta("structure", "write", "tenancy:manage"),
  delete_structure_node: meta("structure", "destructive", "tenancy:manage"),
  place_member: meta("structure", "write", "tenancy:manage"),
  set_budget: meta("structure", "write", "budgets:manage"),
  add_budget_boost: meta("structure", "write", "budgets:manage"),
  remove_budget_boost: meta("structure", "write", "budgets:manage"),
  set_budget_alerts: meta("structure", "write", "budgets:manage"),
  list_users: meta("access", "read", "users:read"),
  list_roles: meta("access", "read", "roles:manage"),
  set_user_blocked: meta("access", "destructive", "users:manage"),
  assign_user_role: meta("access", "write", "users:manage"),
  revoke_user_sessions: meta("access", "destructive", "users:security"),
  get_settings: meta("settings", "read", "settings:read"),
  get_guardrails: meta("settings", "read", "settings:read"),
  test_pii: meta("settings", "read", "settings:read"),
  update_guardrails: meta("settings", "write", "settings:manage"),
  update_gateway_settings: meta("settings", "write", "settings:manage"),
} as const satisfies Record<AssistantToolName, AssistantToolMeta>;

export const assistantToolNames = Object.keys(assistantToolCatalog) as AssistantToolName[];

export const assistantToolGroups = [
  "general",
  "usage",
  "providers",
  "models",
  "keys",
  "structure",
  "access",
  "settings",
] as const satisfies readonly AssistantToolGroup[];

export function isAssistantToolName(value: unknown): value is AssistantToolName {
  return typeof value === "string" && Object.hasOwn(assistantToolCatalog, value);
}

export function assistantToolList(value: unknown): AssistantToolName[] {
  if (!Array.isArray(value)) return [];
  const set = new Set(value.filter(isAssistantToolName));
  return assistantToolNames.filter((name) => set.has(name));
}

export function isWriteAccess(access: AssistantToolAccess): boolean {
  return access !== "read";
}

export function assistantToolPermitted(
  name: AssistantToolName,
  gate: Omit<AssistantToolGate, "allowWrite">,
): boolean {
  if (gate.disabledTools.includes(name)) return false;
  const { permission } = assistantToolCatalog[name];
  return permission === null || gate.permissions.includes(permission);
}

export function assistantToolAllowed(name: AssistantToolName, gate: AssistantToolGate): boolean {
  if (!assistantToolPermitted(name, gate)) return false;
  return gate.allowWrite || !isWriteAccess(assistantToolCatalog[name].access);
}

export function assistantToolsByGroup(names: readonly AssistantToolName[] = assistantToolNames) {
  return assistantToolGroups
    .map((group) => ({
      group,
      tools: names.filter((name) => assistantToolCatalog[name].group === group),
    }))
    .filter((entry) => entry.tools.length > 0);
}

export function assistantToolViews(
  gate: Omit<AssistantToolGate, "allowWrite">,
): AssistantToolView[] {
  return assistantToolNames
    .filter((name) => assistantToolPermitted(name, gate))
    .map((name) => ({ name, access: assistantToolCatalog[name].access }));
}
