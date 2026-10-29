import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/knowledge");
  return <AreaMessages area="(app)/knowledge">{children}</AreaMessages>;
}
