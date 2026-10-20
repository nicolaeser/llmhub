import { requirePlatformScope } from "@/lib/auth/guards";

export default async function ModelsLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformScope();
  return children;
}
