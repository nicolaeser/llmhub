import type { AntigravityFamily } from "@/types/providers";

export const ANTIGRAVITY_INTERNAL_MODELS: ReadonlySet<string> = new Set([
  "chat_20706",
  "chat_23310",
  "tab_flash_lite_preview",
  "tab_jump_flash_lite_preview",
]);

export const ANTIGRAVITY_HIDDEN_MODELS: ReadonlySet<string> = new Set([
  ...ANTIGRAVITY_INTERNAL_MODELS,
  "gemini-2.5-flash-thinking",
  "gemini-2.5-pro",
]);

export const ANTIGRAVITY_FAMILIES = [
  "gemini_pro",
  "gemini_flash",
  "gemini_image",
  "claude",
  "gpt_oss",
  "other",
] as const satisfies readonly AntigravityFamily[];

export function antigravityFamily(id: string): AntigravityFamily {
  const model = id.trim().toLowerCase();
  if (model.startsWith("claude")) return "claude";
  if (model.startsWith("gpt-oss")) return "gpt_oss";
  if (!model.startsWith("gemini")) return "other";
  if (model.includes("image")) return "gemini_image";
  if (model.includes("flash")) return "gemini_flash";
  if (model.includes("pro")) return "gemini_pro";
  return "other";
}
