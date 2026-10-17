import type { JsonMap } from "@/types/gateway";
import type { ModelVariant } from "@/types/models";

export const MODEL_VARIANTS: readonly ModelVariant[] = ["fast", "ultrafast", "daybreak"];

export const DAYBREAK_AUTO = "daybreak";

export const VARIANT_LABELS: Record<ModelVariant, string> = {
  fast: "Fast",
  ultrafast: "Ultra Fast",
  daybreak: "Daybreak",
};

export function isModelVariant(value: unknown): value is ModelVariant {
  return typeof value === "string" && (MODEL_VARIANTS as readonly string[]).includes(value);
}

export function variantsOf(value: unknown): ModelVariant[] {
  const list: unknown[] = Array.isArray(value) ? value : [];
  return MODEL_VARIANTS.filter((variant) => list.includes(variant));
}

export function variantAlias(alias: string, variant: ModelVariant): string {
  return `${alias}-${variant}`;
}

export function splitVariant(model: string): { alias: string; variant: ModelVariant } | null {
  for (const variant of MODEL_VARIANTS) {
    const suffix = `-${variant}`;
    if (model.length > suffix.length && model.endsWith(suffix)) {
      return { alias: model.slice(0, -suffix.length), variant };
    }
  }
  return null;
}

export function variantBody(body: JsonMap, model: string, variant: ModelVariant): JsonMap {
  if (variant === "daybreak") {
    const programs = body.access_programs;
    const known = programs && typeof programs === "object" && !Array.isArray(programs) ? programs : {};
    return { ...body, model, access_programs: { ...known, cyber: DAYBREAK_AUTO } };
  }
  return { ...body, model, service_tier: variant };
}
