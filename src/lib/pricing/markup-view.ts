import type { MarkupKind } from "@/types/pricing";

export function markupKindOf(percent: number): MarkupKind | "none" {
  if (percent > 0) return "markup";
  if (percent < 0) return "discount";
  return "none";
}
