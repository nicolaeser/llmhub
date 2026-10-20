import { requirePlatformScope } from "@/lib/auth/guards";

export default async function ProvidersLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformScope();
  return children;
}
