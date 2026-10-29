"use server";

import { runAction } from "@/lib/http/action-result";
import { countNewLogs, loadLogDetail, loadLogOptions, loadLogs } from "@/lib/gateway/request-logs/explorer";
import { loadLogSession, loadLogSessionChat, loadLogSessions } from "@/lib/gateway/request-logs/sessions";
import { loadAliases } from "@/lib/models/aliases";

export async function loadLogsAction(...args: Parameters<typeof loadLogs>) {
  return runAction(() => loadLogs(...args));
}

export async function countNewLogsAction(...args: Parameters<typeof countNewLogs>) {
  return runAction(() => countNewLogs(...args));
}

export async function loadLogOptionsAction(...args: Parameters<typeof loadLogOptions>) {
  return runAction(() => loadLogOptions(...args));
}

export async function loadLogDetailAction(...args: Parameters<typeof loadLogDetail>) {
  return runAction(() => loadLogDetail(...args));
}

export async function loadLogSessionsAction(...args: Parameters<typeof loadLogSessions>) {
  return runAction(() => loadLogSessions(...args));
}

export async function loadLogSessionAction(...args: Parameters<typeof loadLogSession>) {
  return runAction(() => loadLogSession(...args));
}

export async function loadLogSessionChatAction(...args: Parameters<typeof loadLogSessionChat>) {
  return runAction(() => loadLogSessionChat(...args));
}

export async function loadAliasesAction(...args: Parameters<typeof loadAliases>) {
  return runAction(() => loadAliases(...args));
}
