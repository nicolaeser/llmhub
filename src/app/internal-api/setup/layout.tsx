import type { Metadata } from "next";
import { redirect } from "next/navigation";
import prisma from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await prisma.user.count()) > 0) redirect("/");
  return children;
}
