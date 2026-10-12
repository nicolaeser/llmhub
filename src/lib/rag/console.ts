import "server-only";
import prisma from "@/lib/db/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { companyOf, inCompany } from "@/lib/auth/scope";
import { writeAudit } from "@/lib/gateway/audit";
import { deleteObject, putObject } from "@/lib/gateway/objects";
import { chunkSettings } from "@/lib/rag/chunking";
import { attributesOf } from "@/lib/rag/filters";
import { kickIngest } from "@/lib/rag/ingest";
import { scopeOf } from "@/lib/rag/scope";
import {
  attachFiles,
  consoleFileOwner,
  createVectorStore,
  deleteVectorStore,
  detachFile,
  emptyCounts,
  fileError,
  storeStatus,
  storeUsage,
  updateVectorStore,
  vectorDefaults,
  type StoreRow,
} from "@/lib/rag/stores";
import type { z } from "zod";
import type { companyStoreSchema, updateCompanyStoreSchema } from "@/schemas/rag";
import type { AuthenticatedSession } from "@/types/auth";
import type { VectorFileStatus, VectorFileView, VectorStoreView } from "@/types/rag";

const storeInclude = {
  org: { select: { alias: true } },
  project: { select: { alias: true } },
  member: { select: { name: true } },
  user: { select: { username: true } },
} as const;

type StoreWithNames = Prisma.VectorStoreGetPayload<{ include: typeof storeInclude }>;

function visibleStores(session: AuthenticatedSession): Prisma.VectorStoreWhereInput {
  const company = companyOf(session);
  return company ? { orgId: company } : {};
}

function toView(row: StoreWithNames, usage: Awaited<ReturnType<typeof storeUsage>>): VectorStoreView {
  const stats = usage.get(row.id) ?? { counts: emptyCounts(), usageBytes: 0 };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: scopeOf(row),
    orgId: row.orgId,
    orgName: row.org?.alias ?? "",
    projectId: row.projectId,
    projectName: row.project?.alias ?? "",
    memberId: row.memberId,
    memberName: row.member?.name ?? "",
    userId: row.userId,
    userName: row.user?.username ?? "",
    embeddingModel: row.embeddingModel,
    embeddingDimensions: row.dimensions || row.embeddingDimensions,
    rerankModel: row.rerankModel,
    ocrModel: row.ocrModel,
    chunkMaxTokens: row.chunkMaxTokens,
    chunkOverlapTokens: row.chunkOverlapTokens,
    status: storeStatus(row, stats.counts),
    fileCounts: stats.counts,
    usageBytes: stats.usageBytes,
    expiresAfterDays: row.expiresAfterDays,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastActiveAt: row.lastActiveAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

async function views(rows: StoreWithNames[]): Promise<VectorStoreView[]> {
  const usage = await storeUsage(rows.map((row) => row.id));
  return rows.map((row) => toView(row, usage));
}

async function viewOf(id: string): Promise<VectorStoreView> {
  const row = await prisma.vectorStore.findUniqueOrThrow({ where: { id }, include: storeInclude });
  return (await views([row]))[0]!;
}

export async function visibleStore(session: AuthenticatedSession, id: string): Promise<StoreRow> {
  const row = id ? await prisma.vectorStore.findUnique({ where: { id } }) : null;
  if (!row || !inCompany(session, row.orgId)) throw new Error("NOT_FOUND");
  return row;
}

export async function consoleStoreView(session: AuthenticatedSession, id: string): Promise<VectorStoreView> {
  return viewOf((await visibleStore(session, id)).id);
}

async function assertModels(aliases: string[]): Promise<void> {
  const wanted = [...new Set(aliases.filter(Boolean))];
  if (!wanted.length) return;
  const found = await prisma.modelGroup.count({ where: { alias: { in: wanted } } });
  if (found !== wanted.length) throw new Error("UNKNOWN_MODEL");
}

export async function listConsoleStores(session: AuthenticatedSession) {
  const company = companyOf(session);
  const [rows, companies, projects, defaults] = await Promise.all([
    prisma.vectorStore.findMany({
      where: visibleStores(session),
      include: storeInclude,
      orderBy: [{ createdAt: "desc" }],
      take: 1000,
    }),
    prisma.organization.findMany({
      where: company ? { id: company } : {},
      select: { id: true, alias: true },
      orderBy: { alias: "asc" },
    }),
    prisma.project.findMany({
      where: company ? { orgId: company } : { orgId: { not: null } },
      select: { id: true, alias: true, orgId: true },
      orderBy: { alias: "asc" },
    }),
    vectorDefaults(),
  ]);
  return {
    stores: await views(rows),
    companies,
    projects: projects.map((project) => ({ id: project.id, alias: project.alias, orgId: project.orgId ?? "" })),
    defaults,
  };
}

export async function createConsoleStore(
  session: AuthenticatedSession,
  input: z.infer<typeof companyStoreSchema> & { projectId: string | null },
): Promise<VectorStoreView> {
  if (!inCompany(session, input.orgId)) throw new Error("FORBIDDEN");
  const org = await prisma.organization.findUnique({ where: { id: input.orgId }, select: { id: true } });
  if (!org) throw new Error("ORG_NOT_FOUND");
  if (input.projectId) {
    const project = await prisma.project.findUnique({ where: { id: input.projectId }, select: { orgId: true } });
    if (!project || project.orgId !== input.orgId) throw new Error("PROJECT_NOT_FOUND");
  }
  const defaults = await vectorDefaults();
  const embeddingModel = input.embeddingModel || defaults.embedding_model;
  if (!embeddingModel) throw new Error("EMBEDDING_MODEL_REQUIRED");
  await assertModels([embeddingModel, input.rerankModel, input.ocrModel]);
  const chunk = chunkSettings(null, { maxTokens: input.chunkMaxTokens, overlapTokens: input.chunkOverlapTokens });
  const row = await createVectorStore({
    owner: { orgId: input.orgId, projectId: input.projectId, memberId: null, userId: null },
    createdBy: session.user.id,
    name: input.name,
    description: input.description,
    embeddingModel,
    embeddingDimensions: input.embeddingDimensions || (input.embeddingModel ? 0 : defaults.embedding_dimensions),
    rerankModel: input.rerankModel,
    ocrModel: input.ocrModel,
    chunk,
    metadata: {},
    expiresAfterDays: input.expiresAfterDays,
  });
  await writeAudit({
    actor: session.user.id,
    action: "vector_store.create",
    objectType: "vector_store",
    objectId: row.id,
    after: { name: row.name, orgId: row.orgId, projectId: row.projectId, embeddingModel: row.embeddingModel },
  });
  return viewOf(row.id);
}

export async function updateConsoleStore(
  session: AuthenticatedSession,
  input: z.infer<typeof updateCompanyStoreSchema>,
): Promise<VectorStoreView> {
  const row = await visibleStore(session, input.id);
  await assertModels([input.rerankModel, input.ocrModel]);
  await updateVectorStore(row, {
    name: input.name,
    description: input.description,
    rerankModel: input.rerankModel,
    ocrModel: input.ocrModel,
    expiresAfterDays: input.expiresAfterDays,
  });
  await writeAudit({
    actor: session.user.id,
    action: "vector_store.update",
    objectType: "vector_store",
    objectId: row.id,
    before: { name: row.name, rerankModel: row.rerankModel, ocrModel: row.ocrModel, expiresAfterDays: row.expiresAfterDays },
    after: input,
  });
  return viewOf(row.id);
}

export async function deleteConsoleStore(session: AuthenticatedSession, id: string): Promise<string> {
  const row = await visibleStore(session, id);
  const uploads = await prisma.storedObject.findMany({
    where: { owner: consoleFileOwner(row.id) },
    select: { id: true },
  });
  await deleteVectorStore(row.id);
  for (const upload of uploads) await deleteObject(upload.id, consoleFileOwner(row.id));
  await writeAudit({
    actor: session.user.id,
    action: "vector_store.delete",
    objectType: "vector_store",
    objectId: row.id,
    before: { name: row.name, orgId: row.orgId, projectId: row.projectId, memberId: row.memberId, userId: row.userId },
  });
  return row.id;
}

export async function consoleStoreFiles(session: AuthenticatedSession, id: string): Promise<VectorFileView[]> {
  const row = await visibleStore(session, id);
  const files = await prisma.vectorStoreFile.findMany({
    where: { storeId: row.id },
    orderBy: { createdAt: "desc" },
    take: 1000,
  });
  return files.map((file) => ({
    fileId: file.fileId,
    filename: file.filename,
    status: file.status as VectorFileStatus,
    error: fileError(file.lastError),
    usageBytes: file.usageBytes,
    chunkCount: file.chunkCount,
    attributes: attributesOf(file.attributes),
    createdAt: file.createdAt.toISOString(),
  }));
}

export async function uploadConsoleFile(
  session: AuthenticatedSession,
  storeId: string,
  upload: { filename: string; contentType: string; payload: Uint8Array },
): Promise<{ store: VectorStoreView; files: VectorFileView[] }> {
  const row = await visibleStore(session, storeId);
  const stored = await putObject({
    kind: "file",
    owner: consoleFileOwner(row.id),
    filename: upload.filename,
    purpose: "assistants",
    contentType: upload.contentType,
    payload: upload.payload,
  });
  await attachFiles({
    store: row,
    fileOwner: consoleFileOwner(row.id),
    snapshot: { kind: "user", userId: session.user.id, orgId: row.orgId ?? "", actor: session.user.id },
    files: [
      {
        fileId: stored.id,
        chunk: chunkSettings(null, { maxTokens: row.chunkMaxTokens, overlapTokens: row.chunkOverlapTokens }),
        attributes: {},
      },
    ],
    batchId: "",
  });
  kickIngest();
  await writeAudit({
    actor: session.user.id,
    action: "vector_store.file_add",
    objectType: "vector_store",
    objectId: row.id,
    after: { fileId: stored.id, filename: stored.filename, bytes: stored.bytes },
  });
  return { store: await viewOf(row.id), files: await consoleStoreFiles(session, row.id) };
}

export async function removeConsoleFile(
  session: AuthenticatedSession,
  storeId: string,
  fileId: string,
): Promise<VectorStoreView> {
  const row = await visibleStore(session, storeId);
  if (!(await detachFile(row.id, fileId))) throw new Error("NOT_FOUND");
  await deleteObject(fileId, consoleFileOwner(row.id));
  await writeAudit({
    actor: session.user.id,
    action: "vector_store.file_remove",
    objectType: "vector_store",
    objectId: row.id,
    before: { fileId },
  });
  return viewOf(row.id);
}
