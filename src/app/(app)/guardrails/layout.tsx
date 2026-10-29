import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function GuardrailsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/guardrails");
  return <AreaMessages area="(app)/guardrails">{children}</AreaMessages>;
}
