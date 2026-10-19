"use server";

import { runAction } from "@/lib/http/action-result";
import {
  completeSubAddSignIn,
  openSubAddLink,
  pollSubAddSignIn,
  startSubAddSignIn,
} from "@/lib/providers/sub-add";

export async function openSubAddLinkAction(...args: Parameters<typeof openSubAddLink>) {
  return runAction(() => openSubAddLink(...args));
}

export async function startSubAddSignInAction(...args: Parameters<typeof startSubAddSignIn>) {
  return runAction(() => startSubAddSignIn(...args));
}

export async function pollSubAddSignInAction(...args: Parameters<typeof pollSubAddSignIn>) {
  return runAction(() => pollSubAddSignIn(...args));
}

export async function completeSubAddSignInAction(...args: Parameters<typeof completeSubAddSignIn>) {
  return runAction(() => completeSubAddSignIn(...args));
}
