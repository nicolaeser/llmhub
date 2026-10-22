export const MODEL_ROLES = ["chat", "embedding", "rerank", "ocr", "media", "moderation", "redaction"] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];

export type ModelChoice = {
  alias: string;
  label: string;
  role: ModelRole;
};

const SPECIALTY: { role: Exclude<ModelRole, "chat">; pattern: RegExp }[] = [
  { role: "rerank", pattern: /rerank|ranker/ },
  { role: "ocr", pattern: /(?:^|[^a-z])ocr(?:[^a-z]|$)/ },
  { role: "embedding", pattern: /embed|(?:^|[^a-z])(?:bge|gte|e5)(?:[-_]|$)|(?:^|[^a-z])(?:voyage|nomic)(?:[^a-z]|$)/ },
  {
    role: "media",
    pattern:
      /whisper|(?:^|[^a-z])tts(?:[^a-z]|$)|dall-e|gpt-image|(?:^|[^a-z])(?:imagen|imagine)(?:[^a-z]|$)|stable-diffusion|sdxl|(?:^|[^a-z])flux(?:[^a-z]|$)|transcri/,
  },
  { role: "moderation", pattern: /moderat/ },
  { role: "redaction", pattern: /(?:^|[^a-z])pii(?:[^a-z]|$)|redact|presidio/ },
];

export function modelRole(names: readonly string[]): ModelRole {
  for (const name of names) {
    const folded = name.trim().toLowerCase();
    if (!folded) continue;
    const hit = SPECIALTY.find((item) => item.pattern.test(folded));
    if (hit) return hit.role;
  }
  return "chat";
}

export function choicesForRole(models: readonly ModelChoice[], role: ModelRole, current = ""): ModelChoice[] {
  const matched = models.filter((model) => model.role === role);
  if (!current || matched.some((model) => model.alias === current)) return matched;
  const selected = models.find((model) => model.alias === current);
  return selected ? [...matched, selected] : [...matched, { alias: current, label: current, role }];
}

export function chatChoices(models: readonly ModelChoice[]): ModelChoice[] {
  return models.filter((model) => model.role === "chat");
}
