"use server";

import { runAction } from "@/lib/http/action-result";
import { deleteMarkup, loadMarkups, saveMarkup } from "@/lib/pricing/markups";

export async function loadMarkupsAction(...args: Parameters<typeof loadMarkups>) {
  return runAction(() => loadMarkups(...args));
}

export async function saveMarkupAction(...args: Parameters<typeof saveMarkup>) {
  return runAction(() => saveMarkup(...args));
}

export async function deleteMarkupAction(...args: Parameters<typeof deleteMarkup>) {
  return runAction(() => deleteMarkup(...args));
}
