import "server-only";
import { randomBytes } from "node:crypto";
import { mkdir, open as openFile, readdir, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { open, seal } from "@/lib/crypto";
import { parseJsonOrNull } from "@/lib/utils/json";
import { loginJournalEntrySchema } from "@/schemas/providers";
import type { LoginJournalEntry } from "@/types/providers";

export const LOGIN_JOURNAL_DIR = "/login-journal";
export const LOGIN_JOURNAL_KEEP = 3;

const STAMP_DIGITS = 13;
const PROVIDER_FOLDER = /^[A-Za-z0-9_-]{1,128}$/;
const ENTRY_FILE = /^(\d{13})-[0-9a-f]{16}\.login$/;
const TEMP_FILE = /^\..+\.tmp$/;
const STALE_TEMP_MS = 3_600_000;

function missing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "ENOENT";
}

async function syncDirectory(dir: string): Promise<void> {
  const handle = await openFile(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (err) {
    if (!missing(err)) throw err;
  }
}

export class LoginJournal {
  constructor(public dir: string) {}

  async available(): Promise<boolean> {
    try {
      return (await stat(this.dir)).isDirectory();
    } catch {
      return false;
    }
  }

  private folder(providerId: string): string {
    if (!PROVIDER_FOLDER.test(providerId)) throw new Error("the login journal only stores plain provider ids");
    return path.join(this.dir, providerId);
  }

  private async entryNames(folder: string): Promise<string[]> {
    try {
      return (await readdir(folder)).filter((name) => ENTRY_FILE.test(name)).sort().reverse();
    } catch (err) {
      if (missing(err)) return [];
      throw err;
    }
  }

  async record(entry: LoginJournalEntry): Promise<boolean> {
    if (!(await this.available())) return false;
    const folder = this.folder(entry.providerId);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const name = `${String(entry.refreshedAt).padStart(STAMP_DIGITS, "0")}-${randomBytes(8).toString("hex")}.login`;
    const temp = path.join(folder, `.${name}.tmp`);
    const handle = await openFile(temp, "wx", 0o600);
    try {
      await handle.writeFile(seal(JSON.stringify(loginJournalEntrySchema.parse(entry))), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path.join(folder, name));
    await syncDirectory(folder);
    await this.prune(folder);
    return true;
  }

  private async prune(folder: string): Promise<void> {
    const names = await this.entryNames(folder);
    await Promise.all(names.slice(LOGIN_JOURNAL_KEEP).map((name) => removeQuietly(path.join(folder, name))));
    const now = Date.now();
    for (const name of (await readdir(folder)).filter((file) => TEMP_FILE.test(file))) {
      const file = path.join(folder, name);
      const info = await stat(file).catch(() => null);
      if (info && now - info.mtimeMs > STALE_TEMP_MS) await removeQuietly(file);
    }
  }

  async latestStamp(providerId: string): Promise<number | null> {
    const [newest] = await this.entryNames(this.folder(providerId));
    return newest ? Number(ENTRY_FILE.exec(newest)?.[1]) : null;
  }

  async latest(providerId: string): Promise<LoginJournalEntry | null> {
    const folder = this.folder(providerId);
    for (const name of await this.entryNames(folder)) {
      const text = await readFile(path.join(folder, name), "utf8").catch(() => "");
      const parsed = loginJournalEntrySchema.safeParse(parseJsonOrNull(open(text)));
      if (parsed.success && parsed.data.providerId === providerId) return parsed.data;
    }
    return null;
  }

  async providers(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && PROVIDER_FOLDER.test(entry.name)).map((entry) => entry.name);
    } catch (err) {
      if (missing(err)) return [];
      throw err;
    }
  }

  async forget(providerId: string): Promise<void> {
    await rm(this.folder(providerId), { recursive: true, force: true });
  }

  async removeUnchangedSince(providerId: string, cutoff: number): Promise<boolean> {
    const folder = this.folder(providerId);
    const [newest] = await this.entryNames(folder);
    if (newest) {
      const info = await stat(path.join(folder, newest)).catch(() => null);
      if (!info || info.mtimeMs >= cutoff) return false;
    }
    await rm(folder, { recursive: true, force: true });
    return true;
  }
}

export const loginJournal = new LoginJournal(LOGIN_JOURNAL_DIR);
