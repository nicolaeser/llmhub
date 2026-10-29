import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function KeysLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/keys");
  return <AreaMessages area="(app)/keys">{children}</AreaMessages>;
}
