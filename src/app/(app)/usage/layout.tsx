import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function UsageLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/usage");
  return <AreaMessages area="(app)/usage">{children}</AreaMessages>;
}
