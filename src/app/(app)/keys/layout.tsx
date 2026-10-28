import { requireConsolePage } from "../_components/page-access";

export default async function KeysLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/keys");
  return children;
}
