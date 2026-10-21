import "server-only";

import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { asRecord, asString } from "@/lib/gateway/core";
import { authFileKind } from "@/lib/gateway/upstreams/auth-file-import";
import { McpError } from "@/lib/mcp/errors";
import { guardedFetch } from "@/lib/mcp/transport";
import { checkServerUrl } from "@/lib/mcp/url-guard";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { importUploads } from "@/lib/providers/auth-import";
import { parseJsonOrNull } from "@/lib/utils/json";
import { cliProxyConnectionSchema, cliProxyImportSchema, MAX_AUTH_FILE_BYTES } from "@/schemas/providers";
import type { AuthFileResult, AuthFileUpload, CliProxyAuthFile, CliProxyImport, CliProxyListing } from "@/types/providers";

const MANAGEMENT_PATH = "/v0/management";
const MANAGEMENT_SUFFIX = /\/(?:v0\/management(?:\/.*)?|management\.html)$/i;
const CALL_TIMEOUT_MS = 15_000;
const VERSION_HEADER = "x-cpa-version";
const DOWNLOAD_CONCURRENCY = 4;

type Connection = { base: string; key: string };

function connectionOf(url: string, key: string): Connection {
  const verdict = checkServerUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`, true);
  if (!verdict.ok) throw new Error(verdict.code === "MCP_URL_BLOCKED" ? "DESTINATION_BLOCKED" : "CLIPROXY_URL_INVALID");
  const target = verdict.url;
  target.search = "";
  const path = target.pathname.replace(/\/+$/, "").replace(MANAGEMENT_SUFFIX, "");
  return { base: `${target.origin}${path}`, key };
}

function rejection(status: number, body: string): string {
  const message = asString(asRecord(parseJsonOrNull(body))?.error).toLowerCase();
  if (status === 401) return "CLIPROXY_KEY_REJECTED";
  if (status === 403 && message.includes("banned")) return "CLIPROXY_LOCKED";
  if (status === 403 && message.includes("remote management disabled")) return "CLIPROXY_REMOTE_DISABLED";
  if (status === 403 && message.includes("key not set")) return "CLIPROXY_MANAGEMENT_OFF";
  if (status === 404 && !message) return "CLIPROXY_MANAGEMENT_OFF";
  return "CLIPROXY_FAILED";
}

async function call(
  connection: Connection,
  method: string,
  path: string,
  init: { body?: string } = {},
): Promise<{ status: number; text: string; version: string }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${connection.key}`, Accept: "application/json" };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await guardedFetch(true)(`${connection.base}${MANAGEMENT_PATH}${path}`, {
      method,
      headers,
      body: init.body,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof McpError && error.message === "MCP_URL_BLOCKED") throw new Error("DESTINATION_BLOCKED", { cause: error });
    logger.warn("provider.cliproxy_unreachable", errorFields(error));
    throw new Error("CLIPROXY_UNREACHABLE", { cause: error });
  }
  const text = await res.text().catch(() => "");
  return { status: res.status, text, version: res.headers.get(VERSION_HEADER) ?? "" };
}

function listedFile(raw: unknown): CliProxyAuthFile | null {
  const rec = asRecord(raw);
  const name = asString(rec?.name).trim();
  if (!rec || !name) return null;
  const type = (asString(rec.type) || asString(rec.provider)).trim().toLowerCase();
  const kind = authFileKind({ type });
  const downloadable = /\.json$/i.test(name) && !/[\\/]/.test(name) && rec.runtime_only !== true && asString(rec.source) !== "memory";
  return {
    name,
    type,
    kind,
    account: (asString(rec.email) || asString(rec.account) || asString(rec.label)).trim(),
    status: asString(rec.status).trim(),
    disabled: rec.disabled === true,
    importable: kind !== null && downloadable,
  };
}

async function listFiles(connection: Connection): Promise<CliProxyListing> {
  const { status, text, version } = await call(connection, "GET", "/auth-files");
  if (status !== 200) throw new Error(rejection(status, text));
  const files = asRecord(parseJsonOrNull(text))?.files;
  if (!Array.isArray(files)) throw new Error("CLIPROXY_FAILED");
  return { version, files: files.flatMap((raw) => listedFile(raw) ?? []) };
}

export async function listCliProxyAuthFiles(raw: unknown): Promise<CliProxyListing> {
  await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  const parsed = cliProxyConnectionSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  return listFiles(connectionOf(parsed.data.url, parsed.data.key));
}

async function download(connection: Connection, name: string): Promise<AuthFileUpload | AuthFileResult> {
  try {
    const { status, text } = await call(connection, "GET", `/auth-files/download?name=${encodeURIComponent(name)}`);
    if (status !== 200) return { file: name, status: "failed", error: rejection(status, text) };
    if (Buffer.byteLength(text) > MAX_AUTH_FILE_BYTES) return { file: name, status: "failed", error: "AUTH_FILE_TOO_LARGE" };
    return { name, content: text };
  } catch (error) {
    return { file: name, status: "failed", error: error instanceof Error ? error.message : "CLIPROXY_FAILED" };
  }
}

async function downloads(connection: Connection, names: string[]): Promise<(AuthFileUpload | AuthFileResult)[]> {
  const out: (AuthFileUpload | AuthFileResult)[] = [];
  for (let start = 0; start < names.length; start += DOWNLOAD_CONCURRENCY) {
    out.push(...(await Promise.all(names.slice(start, start + DOWNLOAD_CONCURRENCY).map((name) => download(connection, name)))));
  }
  return out;
}

function movedFiles(results: AuthFileResult[]): string[] {
  const outcome = new Map<string, boolean>();
  for (const result of results) {
    outcome.set(result.file, (outcome.get(result.file) ?? true) && result.status !== "failed");
  }
  return [...outcome].filter(([, ok]) => ok).map(([file]) => file);
}

async function removeAtSource(connection: Connection, name: string): Promise<boolean> {
  try {
    const { status } = await call(connection, "DELETE", `/auth-files?name=${encodeURIComponent(name)}`);
    return status === 200;
  } catch {
    return false;
  }
}

export async function importCliProxyAuthFiles(raw: unknown): Promise<CliProxyImport> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  const parsed = cliProxyImportSchema.safeParse(raw);
  if (!parsed.success) throw new Error("VALIDATION");
  const connection = connectionOf(parsed.data.url, parsed.data.key);
  const listing = await listFiles(connection);
  const known = new Map(listing.files.map((file) => [file.name, file]));
  const names = [...new Set(parsed.data.names)];
  const refused: AuthFileResult[] = [];
  const wanted = names.filter((name) => {
    const file = known.get(name);
    if (file?.importable) return true;
    refused.push({ file: name, status: "failed", error: file ? "AUTH_FILE_UNSUPPORTED" : "NOT_FOUND" });
    return false;
  });
  const fetched = await downloads(connection, wanted);
  const uploads = fetched.filter((item): item is AuthFileUpload => "content" in item);
  const failed = fetched.filter((item): item is AuthFileResult => !("content" in item));
  const imported = uploads.length ? await importUploads(session.user.id, uploads) : { results: [], providers: [], superseded: [] };
  const removed: string[] = [];
  const keptAtSource: string[] = [];
  if (parsed.data.removeFromSource) {
    for (const name of movedFiles(imported.results)) {
      if (await removeAtSource(connection, name)) removed.push(name);
      else keptAtSource.push(name);
    }
  }
  await writeAudit({
    actor: session.user.id,
    action: "provider.import_cliproxy",
    objectType: "provider",
    objectId: "cliproxyapi",
    after: {
      source: connection.base,
      version: listing.version,
      requested: names.length,
      imported: imported.results.filter((result) => result.status !== "failed").length,
      failed: refused.length + failed.length + imported.results.filter((result) => result.status === "failed").length,
      removed,
      keptAtSource,
    },
  });
  return {
    results: [...refused, ...failed, ...imported.results],
    providers: imported.providers,
    superseded: imported.superseded,
    removed,
    keptAtSource,
  };
}
