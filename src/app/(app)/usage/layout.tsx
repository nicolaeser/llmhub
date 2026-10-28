import { requireConsolePage } from "../_components/page-access";

export default async function UsageLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/usage");
  return children;
}
