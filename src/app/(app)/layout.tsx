import Sidebar from "./_components/sidebar";
import ConsoleTopbar from "./_components/console-topbar";
import BuildStatusProvider from "./_components/build-status";
import IgnoreAutofill from "@/components/console/ignore-autofill";
import { requireAuth } from "@/lib/auth/guards";
import { currentBuild } from "@/lib/updates/build";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAuth();

  return (
    <BuildStatusProvider version={currentBuild()}>
      <IgnoreAutofill />
      <Sidebar
        user={{
          email: session.user.email,
          username: session.user.username,
        }}
        permissions={session.permissions}
      >
        <ConsoleTopbar />
        <main className="min-h-0 flex-1 scroll-pt-6 overflow-auto bg-background p-6 lg:scroll-pt-8 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-[1400px]">{children}</div>
        </main>
      </Sidebar>
    </BuildStatusProvider>
  );
}
