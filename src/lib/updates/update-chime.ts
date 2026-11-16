import { errorFields } from "@/lib/logging/format";
import type { UpdaterView } from "@/types/updates";

export type ChimeTone = "success" | "failure";

export const CHIME_CHANNEL = "llmhub-update-chime-v1";
export const CHIME_WINDOW_MS = 2 * 60_000;

const PLAYED_KEY = "llmhub.updateChime.played";
const MUTED_KEY = "llmhub.updateChime.muted";
const MUTED_EVENT = "llmhub:update-chime-muted";
const VISIBLE_CLAIM_MS = 150;
const HIDDEN_CLAIM_MS = 450;
const CLAIM_JITTER_MS = 100;
const NOTE_GAP_S = 0.17;
const NOTE_LENGTH_S = 1.1;

const NOTES: Record<ChimeTone, { frequencies: number[]; wave: OscillatorType; peak: number }> = {
  success: { frequencies: [659.25, 987.77], wave: "sine", peak: 0.2 },
  failure: { frequencies: [493.88, 369.99], wave: "triangle", peak: 0.16 },
};

type Claim = { type: "claim"; key: string };

export function finishedRunChime(
  seenAt: string | null | undefined,
  result: UpdaterView["lastResult"],
  now: number,
): ChimeTone | null {
  if (seenAt === undefined || !result || result.action !== "update" || result.at === seenAt) return null;
  const age = now - Date.parse(result.at);
  if (!Number.isFinite(age) || age > CHIME_WINDOW_MS) return null;
  if (result.outcome === "updated") return "success";
  return result.outcome === "failed" || result.outcome === "rolled_back" ? "failure" : null;
}

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function chimeMuted(): boolean {
  return readStorage(MUTED_KEY) === "muted";
}

export function setChimeMuted(muted: boolean) {
  writeStorage(MUTED_KEY, muted ? "muted" : null);
  window.dispatchEvent(new Event(MUTED_EVENT));
}

export function onChimeMutedChange(onChange: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === MUTED_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(MUTED_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(MUTED_EVENT, onChange);
  };
}

function canPlay(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  return activation ? activation.hasBeenActive : true;
}

function claimDelay(): number {
  if (document.visibilityState === "visible" && document.hasFocus()) return 0;
  const base = document.visibilityState === "visible" ? VISIBLE_CLAIM_MS : HIDDEN_CLAIM_MS;
  return base + Math.random() * CLAIM_JITTER_MS;
}

function isClaim(data: unknown, key: string): boolean {
  return Boolean(data && typeof data === "object" && (data as Claim).type === "claim" && (data as Claim).key === key);
}

function openChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    return new BroadcastChannel(CHIME_CHANNEL);
  } catch (err) {
    console.warn("update_chime.channel_unavailable", errorFields(err));
    return null;
  }
}

export async function playChime(tone: ChimeTone) {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
  const context = new AudioContext();
  try {
    if (context.state === "suspended") await context.resume();
    const { frequencies, wave, peak } = NOTES[tone];
    const start = context.currentTime + 0.03;
    frequencies.forEach((frequency, index) => {
      const at = start + index * NOTE_GAP_S;
      for (const [multiple, level] of [[1, peak], [2, peak / 6]] as const) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = wave;
        oscillator.frequency.value = frequency * multiple;
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(level, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH_S);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + NOTE_LENGTH_S);
      }
    });
    const lengthMs = (frequencies.length * NOTE_GAP_S + NOTE_LENGTH_S) * 1_000 + 200;
    setTimeout(() => void context.close().catch(() => {}), lengthMs);
  } catch (err) {
    console.warn("update_chime.play_failed", errorFields(err));
    void context.close().catch(() => {});
  }
}

export function requestUpdateChime(key: string, tone: ChimeTone) {
  if (typeof window === "undefined" || chimeMuted() || !canPlay() || readStorage(PLAYED_KEY) === key) return;
  const channel = openChannel();
  let claimedElsewhere = false;
  if (channel) {
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (isClaim(event.data, key)) claimedElsewhere = true;
    };
  }
  setTimeout(() => {
    const claimed = !claimedElsewhere && readStorage(PLAYED_KEY) !== key;
    if (claimed) {
      writeStorage(PLAYED_KEY, key);
      try {
        channel?.postMessage({ type: "claim", key } satisfies Claim);
      } catch (err) {
        console.warn("update_chime.broadcast_failed", errorFields(err));
      }
      void playChime(tone);
    }
    channel?.close();
  }, claimDelay());
}
