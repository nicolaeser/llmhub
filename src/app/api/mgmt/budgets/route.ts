import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, respondList } from "@/lib/management/http";
import { serializeBudget } from "@/lib/management/serialize";
import { budgetHolders } from "@/lib/management/structure";
import { loadStructure } from "@/lib/tenancy/structure";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(
    budgetHolders(structure).map((holder) => serializeBudget(holder.kind, holder)),
    { alert_thresholds: structure.thresholds },
  );
});
