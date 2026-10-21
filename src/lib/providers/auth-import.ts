import "server-only";

import prisma from "@/lib/db/prisma";
import { requirePlatformPermission } from "@/lib/auth/guards";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { writeAudit } from "@/lib/audit";
import { scheduleCatalogTask } from "@/lib/gateway/catalog/catalog-tasks";
import {
  authFileEntries,
  authFileEntryFor,
  authFileKind,
  freshAuthFileSession,
  parseAuthFileEntry,
} from "@/lib/gateway/upstreams/auth-file-import";
import { reactivateAccount } from "@/lib/gateway/routing/account-reactivation";
import { loginData } from "@/lib/gateway/upstreams/credentials";
import { PROVIDER_CATALOG } from "@/lib/gateway/upstreams/provider-kinds";
import { sealCredential } from "@/lib/gateway/upstreams/subscription-sign-in";
import { isActionCode } from "@/lib/http/action-result";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { matchingConnection, pruneSupersededLogins } from "@/lib/providers/account-match";
import { providerAuditAfter, providerInclude, publicProvider } from "@/lib/providers/connections";
import { authFileImportSchema, signInFileSchema } from "@/schemas/providers";
import type {
  AuthFileAccount,
  AuthFileImport,
  AuthFileResult,
  AuthFileUpload,
  ProviderView,
  SignInFileResult,
  SignInKind,
  SignInSession,
} from "@/types/providers";

const MAX_IMPORT_ACCOUNTS = 100;
const FRESHEN_CONCURRENCY = 4;

type ParsedEntry = { file: string; account: AuthFileAccount } | { file: string; kind?: SignInKind; error: string };

type FreshEntry =
  | { file: string; kind: SignInKind; session: SignInSession }
  | { file: string; kind?: SignInKind; error: string };

function failureCode(error: unknown, kind?: SignInKind): string {
  const message = error instanceof Error ? error.message : "";
  if (isActionCode(message)) return message;
  logger.warn("provider.auth_file_import_failed", { kind: kind ?? "", ...errorFields(error) });
  return "REQUEST_FAILED";
}

function parsedEntries(files: AuthFileUpload[]): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  let accounts = 0;
  for (const upload of files) {
    let entries: unknown[];
    try {
      entries = authFileEntries(upload.content);
    } catch (error) {
      out.push({ file: upload.name, error: failureCode(error) });
      continue;
    }
    for (const entry of entries) {
      if (accounts >= MAX_IMPORT_ACCOUNTS) {
        out.push({ file: upload.name, error: "AUTH_FILE_TOO_MANY" });
        continue;
      }
      accounts += 1;
      try {
        out.push({ file: upload.name, account: parseAuthFileEntry(entry) });
      } catch (error) {
        const kind = authFileKind(entry);
        out.push({ file: upload.name, ...(kind ? { kind } : {}), error: failureCode(error) });
      }
    }
  }
  return out;
}

async function freshEntry(entry: ParsedEntry): Promise<FreshEntry> {
  if ("error" in entry) return entry;
  const { kind } = entry.account;
  try {
    return { file: entry.file, kind, session: await freshAuthFileSession(entry.account) };
  } catch (error) {
    return { file: entry.file, kind, error: failureCode(error, kind) };
  }
}

async function freshEntries(entries: ParsedEntry[]): Promise<FreshEntry[]> {
  const out: FreshEntry[] = [];
  for (let start = 0; start < entries.length; start += FRESHEN_CONCURRENCY) {
    out.push(...(await Promise.all(entries.slice(start, start + FRESHEN_CONCURRENCY).map(freshEntry))));
  }
  return out;
}

async function storeAccount(
  actor: string,
  kind: SignInKind,
  session: SignInSession,
): Promise<{ status: "created" | "updated"; provider: ProviderView }> {
  const spec = PROVIDER_CATALOG.find((item) => item.kind === kind);
  const baseUrl = spec?.default_base_url ?? "";
  const login = loginData(session);
  const existing = await matchingConnection(kind, session);
  const row = existing
    ? await prisma.providerConnection.update({
        where: { id: existing },
        data: {
          ...(baseUrl ? { baseUrl } : {}),
          login: { upsert: { create: login, update: { ...login, version: { increment: 1 } } } },
        },
        include: providerInclude,
      })
    : await prisma.providerConnection.create({
        data: { name: spec?.name ?? kind, kind, baseUrl, apiKey: "", login: { create: login } },
        include: providerInclude,
      });
  const status = existing ? "updated" : "created";
  if (existing) await reactivateAccount(row.id);
  await writeAudit({
    actor,
    action: "provider.import_auth_file",
    objectType: "provider",
    objectId: row.id,
    after: providerAuditAfter(row, { outcome: status, signInAccount: session.account, plan: session.plan }),
  });
  await scheduleCatalogTask({ task: "provider", providerId: row.id });
  return { status, provider: publicProvider(row) };
}

export async function importAuthFiles(files: AuthFileUpload[]): Promise<AuthFileImport> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  const parsed = authFileImportSchema.safeParse(files);
  if (!parsed.success) throw new Error("VALIDATION");
  return importUploads(session.user.id, parsed.data);
}

export async function importUploads(actor: string, files: AuthFileUpload[]): Promise<AuthFileImport> {
  const fresh = await freshEntries(parsedEntries(files));
  const results: AuthFileResult[] = [];
  const providers = new Map<string, ProviderView>();
  for (const entry of fresh) {
    if ("error" in entry) {
      results.push({ file: entry.file, ...(entry.kind ? { kind: entry.kind } : {}), status: "failed", error: entry.error });
      continue;
    }
    const detail = { file: entry.file, kind: entry.kind, account: entry.session.account, plan: entry.session.plan };
    try {
      const stored = await storeAccount(actor, entry.kind, entry.session);
      providers.set(stored.provider.id, stored.provider);
      results.push({ ...detail, status: stored.status });
    } catch (error) {
      results.push({ ...detail, status: "failed", error: failureCode(error, entry.kind) });
    }
  }
  const superseded = await pruneSupersededLogins(actor);
  return {
    results,
    providers: [...providers.values()].filter((provider) => !superseded.includes(provider.id)),
    superseded,
  };
}

export async function importSignInFile(kind: string, content: string): Promise<SignInFileResult> {
  const session = await requirePlatformPermission(PERMISSIONS.PROVIDERS_MANAGE);
  const parsed = signInFileSchema.safeParse({ kind, content });
  if (!parsed.success) throw new Error("VALIDATION");
  const account = parseAuthFileEntry(authFileEntryFor(authFileEntries(parsed.data.content), parsed.data.kind));
  const fresh = await freshAuthFileSession(account);
  return {
    credential: sealCredential(session.user.id, account.kind, fresh),
    account: fresh.account,
    plan: fresh.plan,
  };
}
