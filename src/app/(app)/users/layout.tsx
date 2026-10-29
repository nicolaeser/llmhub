import AreaMessages from "@/components/i18n/area-messages";
import { requireConsolePage } from "../_components/page-access";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/users");
  return <AreaMessages area="(app)/users">{children}</AreaMessages>;
}
