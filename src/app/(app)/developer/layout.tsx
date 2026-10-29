import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function DeveloperLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/developer");
  return <AreaMessages area="(app)/developer">{children}</AreaMessages>;
}
