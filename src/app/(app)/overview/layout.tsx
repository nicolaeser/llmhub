import { requireConsolePage } from "../_components/page-access";

export default async function OverviewLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/overview");
  return children;
}
