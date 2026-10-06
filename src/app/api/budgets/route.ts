import { PERMISSIONS } from "@/lib/auth/permissions";
import { managementRoute, respondList } from "@/lib/management/http";
import { serializeBudget } from "@/lib/management/serialize";
import { budgetHolders, loadStructure } from "@/lib/management/structure";

export const dynamic = "force-dynamic";

export const GET = managementRoute(PERMISSIONS.TENANCY_READ, async () => {
  const structure = await loadStructure();
  return respondList(
    budgetHolders(structure).map((holder) => serializeBudget(holder.kind, holder)),
    { alert_thresholds: structure.thresholds },
  );
});
