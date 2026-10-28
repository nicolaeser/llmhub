import { requireConsolePage } from "../_components/page-access";

export default async function DeveloperLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/developer");
  return children;
}
