import { requireConsolePage } from "../_components/page-access";

export default async function McpLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/mcp");
  return children;
}
