"use server";

import prisma from "@/lib/db/prisma";
import { requirePermission } from "@/lib/auth/guards";
import { hasPerm, PERMISSIONS } from "@/lib/auth/permissions";
import { MAX_UPLOAD_BYTES } from "@/lib/http/api";
import { runAction } from "@/lib/http/action-result";
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

export async function loadKnowledgeAction() {
  return runAction(async (): Promise<KnowledgeView> => {
    const session = await requirePermission(PERMISSIONS.TENANCY_READ);
    const [data, aliases] = await Promise.all([
      listConsoleStores(session),
      prisma.modelGroup.findMany({ where: { enabled: true }, select: { alias: true }, orderBy: { alias: "asc" } }),
    ]);
    return {
      ...data,
      aliases: aliases.map((row) => row.alias),
      canManage: hasPerm(session.permissions, PERMISSIONS.TENANCY_MANAGE),
      maxUploadBytes: MAX_UPLOAD_BYTES,
    };
  });
}

export async function createKnowledgeAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
    const input = parseInput(companyStoreSchema, raw);
    return { store: await createConsoleStore(session, input) };
  });
}

export async function updateKnowledgeAction(raw: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
    const input = parseInput(updateCompanyStoreSchema, raw);
    return { store: await updateConsoleStore(session, input) };
  });
}

export async function deleteKnowledgeAction(id: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
    return { id: await deleteConsoleStore(session, idOf(id)) };
  });
}

export async function listKnowledgeFilesAction(id: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.TENANCY_READ);
    const storeId = idOf(id);
    const [files, store] = await Promise.all([consoleStoreFiles(session, storeId), consoleStoreView(session, storeId)]);
    return { files, store };
  });
}

export async function removeKnowledgeFileAction(storeId: unknown, fileId: unknown) {
  return runAction(async () => {
    const session = await requirePermission(PERMISSIONS.TENANCY_MANAGE);
    const file = idOf(fileId);
    return { store: await removeConsoleFile(session, idOf(storeId), file), fileId: file };
  });
}
