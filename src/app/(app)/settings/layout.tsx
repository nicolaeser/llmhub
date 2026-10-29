import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/settings");
  return <AreaMessages area="(app)/settings">{children}</AreaMessages>;
}
