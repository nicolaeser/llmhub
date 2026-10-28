import { requireConsolePage } from "../_components/page-access";

export default async function LogsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/logs");
  return children;
}
