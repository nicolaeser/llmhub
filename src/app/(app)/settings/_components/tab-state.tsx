"use client";

import { LoadError, PageLoading } from "@/components/console/page-status";
import type { LoadStatus } from "@/types/actions";

export default function TabState({ state }: { state: LoadStatus }) {
  return state.error === null ? <PageLoading layout="form" /> : <LoadError state={state} />;
}
