import { redirect } from "next/navigation";
import prisma from "@/lib/db/prisma";

export const dynamic = "force-dynamic";

export default async function SetupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if ((await prisma.user.count()) > 0) redirect("/");
  return children;
}
