import { requireConsolePage } from "../_components/page-access";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/settings");
  return children;
}
