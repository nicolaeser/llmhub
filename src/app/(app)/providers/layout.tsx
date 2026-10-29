import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function ProvidersLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/providers");
  return <AreaMessages area="(app)/providers">{children}</AreaMessages>;
}
