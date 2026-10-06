import Sidebar from "./_components/sidebar";
import ConsoleTopbar from "./_components/console-topbar";
import AssistantProvider from "./_components/assistant-session";
import { requireAuth } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAuth();

  return (
    <AssistantProvider
      enabled={hasPerm(session.permissions, PERMISSIONS.ASSISTANT_USE)}
    >
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
    </AssistantProvider>
  );
}
