"use server";

import { runAction } from "@/lib/http/action-result";
import { loadOverview } from "@/lib/console/overview";
import { canOpen } from "../_components/nav-data";

export async function loadOverviewAction() {
  return runAction(() => loadOverview(canOpen));
}
