import Sidebar from "./_components/sidebar";
import ConsoleTopbar from "./_components/console-topbar";
import BuildStatusProvider from "./_components/build-status";
import AutoUpdateNotice from "./_components/auto-update-notice";
import IgnoreAutofill from "./_components/ignore-autofill";
import { requireAuth } from "@/lib/auth/guards";
import prisma from "@/lib/db/prisma";
import { currentBuild } from "@/lib/updates/build";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAuth();
  const companies = session.isOwner
    ? await prisma.organization.findMany({ select: { id: true, alias: true }, orderBy: { alias: "asc" } })
    : [];

  return (
    <BuildStatusProvider version={currentBuild()}>
      <IgnoreAutofill />
      <Sidebar
        user={{
          email: session.user.email,
          username: session.user.username,
        }}
        permissions={session.permissions}
        isOwner={session.isOwner}
        companyView={Boolean(session.isOwner && session.workspaceOrgId)}
      >
        <ConsoleTopbar companies={companies} workspaceOrgId={session.workspaceOrgId ?? null} />
        <main className="min-h-0 flex-1 scroll-pt-4 overflow-auto bg-background p-4 sm:scroll-pt-6 sm:p-6 lg:scroll-pt-8 lg:px-10 lg:py-8">
          <div className="mx-auto max-w-[1400px]">
            <AutoUpdateNotice />
            {children}
          </div>
        </main>
      </Sidebar>
    </BuildStatusProvider>
  );
}
