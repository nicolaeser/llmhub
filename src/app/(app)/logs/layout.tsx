import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function LogsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/logs");
  return <AreaMessages area="(app)/logs">{children}</AreaMessages>;
}
