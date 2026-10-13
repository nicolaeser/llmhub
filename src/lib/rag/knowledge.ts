import "server-only";

import { enabledAliases } from "@/lib/models/aliases";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { MAX_UPLOAD_BYTES } from "@/lib/http/api";
import {
  consoleStoreFiles,
  consoleStoreView,
  createConsoleStore,
  deleteConsoleStore,
  listConsoleStores,
  removeConsoleFile,
  updateConsoleStore,
} from "@/lib/rag/console";
import { companyStoreSchema, updateCompanyStoreSchema } from "@/schemas/rag";
import type { ZodType } from "zod";
import type { KnowledgeView } from "@/types/rag";

function parseInput<T>(schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  return parsed.data;
}

function idOf(value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error("MISSING_ID");
  return value;
}

export async function loadKnowledge(): Promise<KnowledgeView> {
  const session = await requirePermission(PERMISSIONS.TENANCY_READ);
  const [data, aliases] = await Promise.all([
    listConsoleStores(session),
    enabledAliases(),
  ]);
  return {
    ...data,
    aliases,
    canManage: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
    maxUploadBytes: MAX_UPLOAD_BYTES,
  };
}

export async function createKnowledge(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
  const input = parseInput(companyStoreSchema, raw);
  return { store: await createConsoleStore(session, input) };
}

export async function updateKnowledge(raw: unknown) {
  const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
  const input = parseInput(updateCompanyStoreSchema, raw);
  return { store: await updateConsoleStore(session, input) };
}

export async function deleteKnowledge(id: unknown) {
  const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
  return { id: await deleteConsoleStore(session, idOf(id)) };
}

export async function listKnowledgeFiles(id: unknown) {
  const session = await requirePermission(PERMISSIONS.TENANCY_READ);
  const storeId = idOf(id);
  const [files, store] = await Promise.all([consoleStoreFiles(session, storeId), consoleStoreView(session, storeId)]);
  return { files, store };
}

export async function removeKnowledgeFile(storeId: unknown, fileId: unknown) {
  const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
  const file = idOf(fileId);
  return { store: await removeConsoleFile(session, idOf(storeId), file), fileId: file };
}
