import { cookies } from "next/headers";
import Sidebar from "./_components/sidebar";
import ConsoleTopbar from "./_components/console-topbar";
import ConsoleScopeProvider from "./_components/console-scope";
import BuildStatusProvider from "./_components/build-status";
import AutoUpdateNotice from "./_components/auto-update-notice";
import IgnoreAutofill from "./_components/ignore-autofill";
import { consoleScopeOf } from "@/lib/auth/console-scope";
import { requireAuth } from "@/lib/auth/guards";
import { currentBuild } from "@/lib/updates/build";
import { SIDEBAR_COOKIE, sidebarCollapsed } from "@/lib/utils/sidebar-cookie";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAuth();
  const scope = await consoleScopeOf(session);
  const collapsed = sidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  const user = { email: session.user.email, username: session.user.username };

  return (
    <BuildStatusProvider version={currentBuild()}>
      <ConsoleScopeProvider initial={scope} permissions={session.permissions}>
        <IgnoreAutofill />
        <Sidebar user={user} permissions={session.permissions} initialCollapsed={collapsed}>
          <ConsoleTopbar user={user} permissions={session.permissions} />
          <main className="min-h-0 flex-1 scroll-pt-4 overflow-auto bg-background p-4 sm:scroll-pt-6 sm:p-6 lg:scroll-pt-8 lg:px-10 lg:py-8">
            <div className="mx-auto max-w-[1400px]">
              <AutoUpdateNotice />
              {children}
            </div>
          </main>
        </Sidebar>
      </ConsoleScopeProvider>
    </BuildStatusProvider>
  );
}
