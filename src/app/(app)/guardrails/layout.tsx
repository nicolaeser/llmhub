import { requireConsolePage } from "../_components/page-access";

export default async function GuardrailsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/guardrails");
  return children;
}
