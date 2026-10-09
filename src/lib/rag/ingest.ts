import "server-only";
import prisma from "@/lib/db/prisma";
import { Prisma } from "@/generated/prisma/client";
import { assertBudget } from "@/lib/gateway/billing";
import { GateError } from "@/lib/gateway/errors";
import { getObject } from "@/lib/gateway/objects";
import { logger } from "@/lib/logging/logger";
import { chunkText } from "@/lib/rag/chunking";
import { extractDocument } from "@/lib/rag/extract";
import { evictFiles } from "@/lib/rag/index-cache";
import { encodeTerms, termBag } from "@/lib/rag/lexical";
import { embedTexts, ocrDocument } from "@/lib/rag/models";
import { ingestPrincipal, vectorDefaults } from "@/lib/rag/stores";
import { encodeVector } from "@/lib/rag/vectors";
import type { Principal } from "@/types/gateway";
import type { TextChunk, VectorFileError } from "@/types/rag";

export const INGEST_ENDPOINT = "vector_store:ingest";
const LEASE_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;
const MAX_ATTEMPTS = 3;
const EMBED_BATCH = 64;
const EMBED_BATCH_CHARS = 300_000;
const INSERT_BATCH = 200;
const CONCURRENCY = 2;
const STATE_KEY = Symbol.for("llmhub.rag.ingest");

type FileKey = { storeId: string; fileId: string };

class IngestFailure extends Error {
  constructor(readonly error: VectorFileError) {
    super(error.message);
  }
}

function fail(code: VectorFileError["code"], message: string): never {
  throw new IngestFailure({ code, message });
}

function where(key: FileKey) {
  return { storeId_fileId: key };
}

function claimable(now: Date): Prisma.VectorStoreFileWhereInput {
  return { status: "in_progress", OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] };
}

async function renewLease(key: FileKey): Promise<boolean> {
  const renewed = await prisma.vectorStoreFile.updateMany({
    where: { ...key, status: "in_progress" },
    data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
  });
  return renewed.count === 1;
}

function embedBatches(chunks: TextChunk[]): TextChunk[][] {
  const batches: TextChunk[][] = [];
  let current: TextChunk[] = [];
  let chars = 0;
  for (const chunk of chunks) {
    if (current.length && (current.length >= EMBED_BATCH || chars + chunk.text.length > EMBED_BATCH_CHARS)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(chunk);
    chars += chunk.text.length;
  }
  if (current.length) batches.push(current);
  return batches;
}

function classify(err: unknown, attempts: number): { retry: boolean; error: VectorFileError } {
  if (err instanceof IngestFailure) return { retry: false, error: err.error };
  if (err instanceof GateError) {
    if (err.code === "pii_blocked") {
      return { retry: false, error: { code: "invalid_file", message: "the file was blocked by the PII policy" } };
    }
    if (err.code === "budget_exceeded") return { retry: false, error: { code: "rate_limit_exceeded", message: err.message } };
    const transient = err.status >= 500 || err.status === 429;
    return {
      retry: transient && attempts < MAX_ATTEMPTS,
      error: { code: err.status === 429 ? "rate_limit_exceeded" : "server_error", message: err.message },
    };
  }
  return {
    retry: attempts < MAX_ATTEMPTS,
    error: { code: "server_error", message: "the file could not be processed" },
  };
}

async function documentText(
  principal: Principal,
  file: { filename: string; contentType: string; payload: Uint8Array },
  ocrModel: string,
): Promise<string> {
  const extraction = extractDocument(file);
  if (extraction.kind === "error") fail(extraction.error.code, extraction.error.message);
  if (extraction.kind === "text") return extraction.text;
  const model = ocrModel || (await vectorDefaults()).ocr_model;
  if (!model) {
    fail(
      "unsupported_file",
      "PDF and image files need an OCR model; set ocr_model on the vector store or a default in Admin settings",
    );
  }
  await assertBudget(principal);
  return ocrDocument({ principal, endpoint: INGEST_ENDPOINT, model, document: extraction.document });
}

async function embedChunks(
  key: FileKey,
  principal: Principal,
  store: { embeddingModel: string; embeddingDimensions: number },
  chunks: TextChunk[],
): Promise<Float32Array[] | null> {
  const vectors: Float32Array[] = [];
  for (const batch of embedBatches(chunks)) {
    if (!(await renewLease(key))) return null;
    await assertBudget(principal);
    vectors.push(
      ...(await embedTexts({
        principal,
        endpoint: INGEST_ENDPOINT,
        model: store.embeddingModel,
        dimensions: store.embeddingDimensions,
        texts: batch.map((chunk) => chunk.text),
      })),
    );
  }
  return vectors;
}

async function settleDimensions(storeId: string, dims: number): Promise<void> {
  await prisma.vectorStore.updateMany({ where: { id: storeId, dimensions: 0 }, data: { dimensions: dims } });
  const store = await prisma.vectorStore.findUnique({ where: { id: storeId }, select: { dimensions: true } });
  if (store && store.dimensions !== dims) {
    fail("server_error", `the embedding model returned ${dims} dimensions but this vector store uses ${store.dimensions}`);
  }
}

async function writeChunks(key: FileKey, chunks: TextChunk[], vectors: Float32Array[]): Promise<number> {
  await prisma.vectorChunk.deleteMany({ where: key });
  let bytes = 0;
  for (let i = 0; i < chunks.length; i += INSERT_BATCH) {
    const data = chunks.slice(i, i + INSERT_BATCH).map((chunk, offset) => {
      const embedding = encodeVector(vectors[i + offset]!);
      const terms = encodeTerms(termBag(chunk.text));
      bytes += Buffer.byteLength(chunk.text) + embedding.byteLength + terms.byteLength;
      return {
        ...key,
        position: chunk.position,
        text: chunk.text,
        tokens: chunk.tokens,
        embedding: new Uint8Array(embedding),
        terms: new Uint8Array(terms),
      };
    });
    await prisma.vectorChunk.createMany({ data });
  }
  return bytes;
}

async function finish(key: FileKey, data: Prisma.VectorStoreFileUpdateManyMutationInput): Promise<boolean> {
  const done = await prisma.vectorStoreFile.updateMany({ where: { ...key, status: "in_progress" }, data });
  evictFiles(key.storeId, [key.fileId]);
  if (done.count === 0) await prisma.vectorChunk.deleteMany({ where: key });
  return done.count === 1;
}

async function ingest(key: FileKey): Promise<void> {
  const row = await prisma.vectorStoreFile.findUnique({ where: where(key), include: { store: true } });
  if (!row || row.status !== "in_progress") return;
  try {
    if (row.attempts > MAX_ATTEMPTS) fail("server_error", "the file could not be processed after several attempts");
    const principal = await ingestPrincipal(row.ingestBy);
    if (!principal) fail("server_error", "the key or user that added this file is no longer active");
    const object = await getObject(row.fileId);
    if (!object || object.kind !== "file") fail("invalid_file", "the file no longer exists");
    const text = await documentText(principal, object, row.store.ocrModel);
    const chunks = chunkText(text, { maxTokens: row.chunkMaxTokens, overlapTokens: row.chunkOverlapTokens });
    if (!chunks.length) fail("invalid_file", "the file contains no text");
    const vectors = await embedChunks(key, principal, row.store, chunks);
    if (!vectors) return;
    await settleDimensions(row.storeId, vectors[0]!.length);
    if (!(await renewLease(key))) return;
    const usageBytes = await writeChunks(key, chunks, vectors);
    await finish(key, {
      status: "completed",
      usageBytes,
      chunkCount: chunks.length,
      indexedAt: new Date(),
      lastError: Prisma.DbNull,
      leaseUntil: null,
    });
  } catch (err) {
    const outcome = classify(err, row.attempts);
    if (outcome.retry) {
      await prisma.vectorStoreFile.updateMany({
        where: { ...key, status: "in_progress" },
        data: { leaseUntil: new Date(Date.now() + RETRY_BASE_MS * Math.max(1, row.attempts)), lastError: outcome.error },
      });
      return;
    }
    await finish(key, { status: "failed", lastError: outcome.error, leaseUntil: null, usageBytes: 0, chunkCount: 0 });
  }
}

async function claimNext(): Promise<FileKey | null> {
  for (let tries = 0; tries < 5; tries++) {
    const now = new Date();
    const next = await prisma.vectorStoreFile.findFirst({
      where: claimable(now),
      orderBy: { createdAt: "asc" },
      select: { storeId: true, fileId: true },
    });
    if (!next) return null;
    const claimed = await prisma.vectorStoreFile.updateMany({
      where: { ...next, ...claimable(now) },
      data: { leaseUntil: new Date(now.getTime() + LEASE_MS), attempts: { increment: 1 } },
    });
    if (claimed.count === 1) return next;
  }
  return null;
}

type IngestState = { running: number };

function ingestState(): IngestState {
  const g = globalThis as unknown as Record<symbol, IngestState>;
  g[STATE_KEY] ??= { running: 0 };
  return g[STATE_KEY];
}

async function drain(): Promise<void> {
  const state = ingestState();
  state.running += 1;
  try {
    for (;;) {
      const key = await claimNext();
      if (!key) return;
      await ingest(key).catch((err) => {
        logger.error("vector_store.ingest_failed", { ...key, err: err instanceof Error ? err.message : String(err) });
      });
    }
  } finally {
    state.running -= 1;
  }
}

export function kickIngest(): void {
  for (let slot = ingestState().running; slot < CONCURRENCY; slot++) {
    void drain().catch((err) => {
      logger.error("vector_store.drain_failed", { err: err instanceof Error ? err.message : String(err) });
    });
  }
}

export async function runPendingIngests(): Promise<number> {
  const pending = await prisma.vectorStoreFile.count({ where: claimable(new Date()) });
  if (pending) kickIngest();
  return pending;
}
