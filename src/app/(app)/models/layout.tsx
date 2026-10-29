import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function ModelsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/models");
  return <AreaMessages area="(app)/models">{children}</AreaMessages>;
}
