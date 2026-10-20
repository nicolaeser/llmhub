import { requirePlatformScope } from "@/lib/auth/guards";

export default async function UsersLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformScope();
  return children;
}
