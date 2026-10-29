import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function McpLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/mcp");
  return <AreaMessages area="(app)/mcp">{children}</AreaMessages>;
}
