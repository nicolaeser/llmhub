import { requireConsolePage } from "../_components/page-access";

export default async function ModelsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/models");
  return children;
}
