import { requireConsolePage } from "../_components/page-access";

export default async function ProvidersLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/providers");
  return children;
}
