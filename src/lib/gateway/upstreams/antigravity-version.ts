import "server-only";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import { cancelQuietly } from "@/lib/utils/streams";
import type { AntigravityVersionState } from "@/types/providers";

export const ANTIGRAVITY_CLIENT_VERSION = "2.29.0";
export const ANTIGRAVITY_MANIFEST_URL =
  "https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml";
export const ANTIGRAVITY_VERSION_TTL_MS = 6 * 3_600_000;
export const ANTIGRAVITY_VERSION_RETRY_MS = 30 * 60_000;
export const ANTIGRAVITY_MANIFEST_MAX_BYTES = 4096;

const MANIFEST_TIMEOUT_MS = 10_000;
const MANIFEST_HEADERS = { "User-Agent": "electron-builder", "Cache-Control": "no-cache" };
const HUB_PLATFORM = "os_type=darwin; arch=arm64";
const HUB_CHANGELISTS: Readonly<Record<string, string>> = {
  "2.23.0": "998057262",
  "2.24.0": "1000335682",
  "2.29.0": "1013060670",
};
const MANIFEST_VERSION_KEY = "version:";
const MANIFEST_VERSION_LINE = /^version:[ \t]+(["']?)(\d{1,6}\.\d{1,6}\.\d{1,6})\1[ \t]*$/;

const versionHolder = globalThis as typeof globalThis & { __llmhubAntigravityVersion?: AntigravityVersionState };

function versionState(): AntigravityVersionState {
  versionHolder.__llmhubAntigravityVersion ??= {
    version: ANTIGRAVITY_CLIENT_VERSION,
    nextCheckAt: 0,
    pending: null,
    failing: false,
  };
  return versionHolder.__llmhubAntigravityVersion;
}

export function hubUserAgent(version: string): string {
  const changelist = HUB_CHANGELISTS[version];
  return `antigravity/hub/${version} (aidev_client; ${HUB_PLATFORM}${changelist ? `; cl=${changelist}` : ""})`;
}

export function parseManifestVersion(text: string): string | null {
  const line = text.split(/\r?\n/).find((entry) => entry.startsWith(MANIFEST_VERSION_KEY));
  return line ? (MANIFEST_VERSION_LINE.exec(line)?.[2] ?? null) : null;
}

function versionParts(version: string): number[] {
  return version.split(".").map(Number);
}

function followsBuiltIn(version: string): boolean {
  const candidate = versionParts(version);
  const builtIn = versionParts(ANTIGRAVITY_CLIENT_VERSION);
  if (candidate[0] !== builtIn[0]) return false;
  for (let index = 1; index < builtIn.length; index++) {
    if (candidate[index] !== builtIn[index]) return candidate[index]! > builtIn[index]!;
  }
  return true;
}

async function manifestText(res: Response): Promise<string> {
  if (Number(res.headers.get("content-length") ?? 0) > ANTIGRAVITY_MANIFEST_MAX_BYTES) {
    await cancelQuietly(res.body);
    throw new Error("antigravity manifest is too large");
  }
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > ANTIGRAVITY_MANIFEST_MAX_BYTES) {
      await cancelQuietly(reader);
      throw new Error("antigravity manifest is too large");
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

async function fetchManifestVersion(): Promise<string> {
  const res = await fetch(ANTIGRAVITY_MANIFEST_URL, {
    headers: MANIFEST_HEADERS,
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
    redirect: "error",
  });
  if (res.status !== 200) {
    await cancelQuietly(res.body);
    throw new Error(`antigravity manifest answered ${res.status}`);
  }
  const version = parseManifestVersion(await manifestText(res));
  if (!version) throw new Error("antigravity manifest has no valid version");
  if (!followsBuiltIn(version)) throw new Error(`antigravity manifest version ${version} does not follow ${ANTIGRAVITY_CLIENT_VERSION}`);
  return version;
}

async function refreshVersion(state: AntigravityVersionState, now: number): Promise<void> {
  try {
    const version = await fetchManifestVersion();
    state.nextCheckAt = now + ANTIGRAVITY_VERSION_TTL_MS;
    state.failing = false;
    if (version === state.version) return;
    logger.info("antigravity_version.changed", { previous: state.version, version });
    state.version = version;
  } catch (err) {
    state.nextCheckAt = now + ANTIGRAVITY_VERSION_RETRY_MS;
    if (!state.failing) logger.warn("antigravity_version.refresh_failed", errorFields(err));
    state.failing = true;
  }
}

export function refreshAntigravityVersion(now = Date.now()): Promise<void> {
  const state = versionState();
  if (state.pending) return state.pending;
  if (now < state.nextCheckAt) return Promise.resolve();
  state.pending = refreshVersion(state, now).finally(() => {
    state.pending = null;
  });
  return state.pending;
}

export function antigravityClientVersion(now = Date.now()): string {
  void refreshAntigravityVersion(now);
  return versionState().version;
}

export function antigravityUserAgent(now = Date.now()): string {
  return hubUserAgent(antigravityClientVersion(now));
}
