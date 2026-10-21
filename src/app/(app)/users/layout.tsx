import { redirect } from "next/navigation";
import { requirePlatformScope } from "@/lib/auth/guards";
import { canOpen } from "../_components/nav-data";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  const session = await requirePlatformScope();
  if (!canOpen(session.permissions, "/users", "platform")) redirect("/");
  return children;
}
