import type { IntegrationStatus } from "@/types/integrations";

export type LifecycleEvent =
  | "configure"
  | "edit"
  | "validate_ok"
  | "validate_fail"
  | "approve"
  | "reject"
  | "publish"
  | "deprecate";

const EDITABLE = new Set<IntegrationStatus>(["draft", "configured", "validated", "reviewed"]);

export function canEdit(status: IntegrationStatus): boolean {
  return EDITABLE.has(status);
}

export function transition(
  status: IntegrationStatus,
  event: LifecycleEvent,
  flags: { approvalRequired?: boolean; approved?: boolean } = {},
): IntegrationStatus | null {
  if (event === "deprecate" && status === "published") return "deprecated";
  if (event === "edit" && (status === "validated" || status === "reviewed")) return "configured";
  if (event === "configure" && (status === "draft" || status === "configured")) return "configured";
  if (event === "validate_fail" && status !== "published" && status !== "deprecated") return "configured";
  if (event === "validate_ok" && (status === "configured" || status === "validated")) return "validated";
  if (event === "reject" && (status === "validated" || status === "reviewed")) return "configured";
  if (event === "approve" && status === "validated") return "reviewed";
  if (event === "publish" && status === "reviewed") return "published";
  if (event === "publish" && status === "validated" && !flags.approvalRequired && flags.approved !== false) {
    return "published";
  }
  return null;
}

export function publishBlocked(status: IntegrationStatus, approvalRequired: boolean, approved: boolean): string {
  if (status === "published") return "already_published";
  if (status === "deprecated") return "deprecated";
  if (status === "draft" || status === "configured") return "not_validated";
  if (approvalRequired && !approved) return "approval_required";
  if (status !== "reviewed" && status !== "validated") return "lifecycle_blocked";
  if (status === "validated" && approvalRequired) return "approval_required";
  return "";
}
