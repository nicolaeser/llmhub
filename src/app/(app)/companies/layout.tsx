import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function CompaniesLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/companies");
  return <AreaMessages area="(app)/companies">{children}</AreaMessages>;
}
