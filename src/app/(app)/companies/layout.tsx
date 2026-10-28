import { requireConsolePage } from "../_components/page-access";

export default async function CompaniesLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/companies");
  return children;
}
