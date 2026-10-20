import { requirePlatformScope } from "@/lib/auth/guards";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requirePlatformScope();
  return children;
}
