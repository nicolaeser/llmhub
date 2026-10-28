import { requireConsolePage } from "../_components/page-access";

export default async function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/knowledge");
  return children;
}
