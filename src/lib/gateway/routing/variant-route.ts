import "server-only";
import prisma from "@/lib/db/prisma";
import { splitVariant, variantsOf } from "@/lib/gateway/catalog/model-variants";
import { routeOf } from "@/lib/gateway/routing/route-pool";
import type { ModelVariant } from "@/types/models";
import type { RoutePool } from "@/types/routing";

export async function variantRoute(
  model: string,
  surface: RoutePool,
): Promise<{ model: string; variant: ModelVariant } | null> {
  const requested = model.trim();
  const { alias } = routeOf(requested, surface);
  const split = splitVariant(alias);
  if (!split) return null;
  const groups = await prisma.modelGroup.findMany({
    where: { alias: { in: [alias, split.alias] } },
    select: { alias: true, enabled: true, variants: true },
  });
  if (groups.some((group) => group.alias === alias && group.enabled)) return null;
  const base = groups.find((group) => group.alias === split.alias);
  if (!base || !variantsOf(base.variants).includes(split.variant)) return null;
  return { model: `${requested.slice(0, requested.length - alias.length)}${split.alias}`, variant: split.variant };
}
