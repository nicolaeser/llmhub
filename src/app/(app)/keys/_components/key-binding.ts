import type { KeyBindingKind, KeyOptions, KeyPlace, KeyPreset } from "@/types/keys";

export function bindingKind(key: { project_id: string; member_id: string }): KeyBindingKind {
  if (key.member_id) return "member";
  if (key.project_id) return "project";
  return "internal";
}

export function placeOf(options: Pick<KeyOptions, "orgs" | "teams">, orgId: string, teamId: string): KeyPlace {
  return {
    org: options.orgs.find((row) => row.id === orgId)?.alias ?? "",
    team: options.teams.find((row) => row.id === teamId)?.alias ?? "",
  };
}

export function parsePreset(value: string | null | undefined): KeyPreset | null {
  const [kind, id] = (value ?? "").split(":");
  if (!id || (kind !== "project" && kind !== "member")) return null;
  return { kind, id };
}
