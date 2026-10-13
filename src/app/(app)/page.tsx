import { redirect } from "next/navigation";
import { requireAuth } from "@/lib/auth/guards";
import { homePath } from "./_components/nav-data";

export default async function ConsoleHome() {
  const session = await requireAuth();
  redirect(homePath(session.permissions));
}
