import "server-only";
import prisma from "@/lib/db/prisma";
import { buildFileIndex } from "@/lib/rag/file-index";
import type { FileIndex } from "@/types/rag";

const BUDGET_BYTES = 256 * 1024 * 1024;
const LOAD_FILES_PER_QUERY = 25;
const CACHE_KEY = Symbol.for("llmhub.rag.index-cache");

type CacheState = { entries: Map<string, FileIndex>; bytes: number };

function state(): CacheState {
  const g = globalThis as unknown as Record<symbol, CacheState>;
  g[CACHE_KEY] ??= { entries: new Map(), bytes: 0 };
  return g[CACHE_KEY];
}

function cacheKey(storeId: string, fileId: string): string {
  return `${storeId}\u0000${fileId}`;
}

function drop(key: string): void {
  const cache = state();
  const entry = cache.entries.get(key);
  if (!entry) return;
  cache.entries.delete(key);
  cache.bytes -= entry.bytes;
}

function remember(key: string, index: FileIndex): void {
  const cache = state();
  drop(key);
  cache.entries.set(key, index);
  cache.bytes += index.bytes;
  for (const [oldest] of cache.entries) {
    if (cache.bytes <= BUDGET_BYTES || oldest === key) break;
    drop(oldest);
  }
}

export function evictStore(storeId: string): void {
  const prefix = `${storeId}\u0000`;
  for (const key of [...state().entries.keys()]) if (key.startsWith(prefix)) drop(key);
}

export function evictFiles(storeId: string, fileIds: string[]): void {
  for (const fileId of fileIds) drop(cacheKey(storeId, fileId));
}

export async function fileIndexes(
  storeId: string,
  dims: number,
  files: { fileId: string; stamp: number }[],
): Promise<Map<string, FileIndex>> {
  const cache = state();
  const out = new Map<string, FileIndex>();
  const stale: { fileId: string; stamp: number }[] = [];
  for (const file of files) {
    const key = cacheKey(storeId, file.fileId);
    const hit = cache.entries.get(key);
    if (hit && hit.stamp === file.stamp && hit.dims === dims) {
      cache.entries.delete(key);
      cache.entries.set(key, hit);
      out.set(file.fileId, hit);
    } else {
      stale.push(file);
    }
  }
  for (let i = 0; i < stale.length; i += LOAD_FILES_PER_QUERY) {
    const slice = stale.slice(i, i + LOAD_FILES_PER_QUERY);
    const rows = await prisma.vectorChunk.findMany({
      where: { storeId, fileId: { in: slice.map((file) => file.fileId) } },
      orderBy: [{ fileId: "asc" }, { position: "asc" }],
      select: { id: true, fileId: true, position: true, embedding: true, terms: true },
    });
    const grouped = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = grouped.get(row.fileId) ?? [];
      list.push(row);
      grouped.set(row.fileId, list);
    }
    for (const file of slice) {
      const index = buildFileIndex(grouped.get(file.fileId) ?? [], dims, file.stamp);
      remember(cacheKey(storeId, file.fileId), index);
      out.set(file.fileId, index);
    }
  }
  return out;
}
