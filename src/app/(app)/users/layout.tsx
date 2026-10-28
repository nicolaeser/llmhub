import { requireConsolePage } from "../_components/page-access";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  await requireConsolePage("/users");
  return children;
}
